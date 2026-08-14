/**
 * Geographic backdrop for the map: water, and administrative boundaries.
 *
 * The network on its own is 319 dots floating on a flat panel, which tells you
 * nothing about where in Seoul you are looking. Two layers fix that cheaply:
 * the 한강, which is the feature every Seoul reader orients by and the reason
 * several lines bend where they do, and the 구/시 boundaries, which give the
 * empty space some texture.
 *
 * Stored in lon/lat, NOT in view units. The server projects it at startup with
 * the same buildProjection() the stations use, so the backdrop is registered to
 * the dots by construction — there is no second transform to keep in step.
 *
 * Two sources, both fetched by `npm run basemap`:
 *
 * - Water: OpenStreetMap via Overpass (natural=water, water=river). The 한강
 *   is two multipolygon relations whose outer ways arrive as loose fragments,
 *   so they are stitched into rings here.
 * - Boundaries: the KOSTAT 2018 municipality set published by southkorea-maps.
 *   Filtered to what the network actually reaches, which is Seoul's 25 구 plus
 *   the neighbouring 시 the lines run out into.
 *
 * Both are simplified to SIMPLIFY_DEG before storage. At the map's scale one
 * view unit is about 0.00034 scaled-degrees, so the tolerance is well under a
 * pixel at zoom 1 and still holds its shape zoomed in.
 */
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the untouched Overpass response is kept, the same way the congestion
 * ingest keeps its API responses. Overpass is rate-limited and its mirrors go
 * down for hours at a time, so a fetch that succeeded once should not have to
 * succeed again to re-derive the backdrop.
 */
const RAW_DIR = join(import.meta.dirname, '..', '..', 'raw');
const WATER_CACHE = join(RAW_DIR, 'osm-water.json');

/** OSM water polygons in the network's bounding box. */
const OVERPASS_HOSTS = ['https://overpass.kumi.systems', 'https://overpass-api.de'];

const MUNICIPALITIES_URL =
  'https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2018/json/skorea-municipalities-2018-geo.json';

/** Douglas-Peucker tolerance, in degrees of latitude (~11m). */
const SIMPLIFY_DEG = 0.0001;

/**
 * Smallest water body worth drawing, as a bounding-box diagonal in degrees
 * (~330m). Below this the OSM extract is farm ponds and settling tanks, which
 * add nothing at city scale and a great many points.
 */
const MIN_WATER_DEG = 0.003;

/** How far beyond the outermost station the backdrop should reach, in degrees. */
const BBOX_PAD_DEG = 0.03;

export type ShapeKind = 'water' | 'district';

export interface BasemapShape {
  kind: ShapeKind;
  /**
   * [lon, lat] pairs. Water is a closed ring, to be filled. A district is an
   * open polyline: the boundaries are clipped to the visible area, and a
   * municipality that leaves and re-enters comes back as several runs.
   */
  points: [number, number][];
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface BasemapReport {
  shapes: BasemapShape[];
  water: number;
  districts: number;
  /** Names of the municipalities kept, for the audit trail. */
  districtNames: string[];
  points: number;
  pointsBeforeSimplify: number;
  overpassHost: string;
}

// --- geometry ------------------------------------------------------------

/**
 * Perpendicular distance from p to the segment a-b, with longitude scaled so a
 * degree east is worth the same as a degree north. Without the correction the
 * simplifier is 21% more aggressive on east-west detail at this latitude.
 */
function perpDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number],
  scaleLon: number,
): number {
  const px = (p[0] - a[0]) * scaleLon;
  const py = p[1] - a[1];
  const bx = (b[0] - a[0]) * scaleLon;
  const by = b[1] - a[1];
  const len = bx * bx + by * by;
  if (len === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len));
  return Math.hypot(px - bx * t, py - by * t);
}

/** Douglas-Peucker. Endpoints always survive, so a closed ring stays closed. */
function simplify(points: [number, number][], tolerance: number, scaleLon: number): [number, number][] {
  if (points.length < 3) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let farthest = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = perpDistance(points[i], points[a], points[b], scaleLon);
      if (d > farthest) {
        farthest = d;
        far = i;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }

  return points.filter((_, i) => keep[i] === 1);
}

function ringSpan(points: [number, number][]): number {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return Math.hypot(maxLon - minLon, maxLat - minLat);
}

/**
 * Liang-Barsky: the part of segment p0-p1 that lies inside the box, or null.
 *
 * Parameterise the segment as p0 + t*(p1-p0) and squeeze t from both ends
 * against each of the four edges. If the window closes, the segment misses.
 */
function clipSegment(
  p0: [number, number],
  p1: [number, number],
  box: BBox,
): [[number, number], [number, number]] | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const edges: [number, number][] = [
    [-dx, p0[0] - box.minLon],
    [dx, box.maxLon - p0[0]],
    [-dy, p0[1] - box.minLat],
    [dy, box.maxLat - p0[1]],
  ];

  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null; // parallel to this edge and outside it
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }

  return [
    [p0[0] + t0 * dx, p0[1] + t0 * dy],
    [p0[0] + t1 * dx, p0[1] + t1 * dy],
  ];
}

/**
 * The parts of a ring that fall inside the box, as open polylines.
 *
 * Half of the municipal boundary points sat outside the map — 파주시 and
 * 남양주시 reach the padded query box with one corner and carry hundreds of
 * points nobody can see. Clipping per segment rather than per polygon is what
 * lets these stay STROKES: a polygon clipper would close each piece along the
 * edge of the map and draw a frame around the whole city.
 */
function clipRuns(points: [number, number][], box: BBox): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  const near = (a: [number, number], b: [number, number]) =>
    Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

  for (let i = 0; i < points.length - 1; i++) {
    const piece = clipSegment(points[i], points[i + 1], box);
    if (!piece) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    const [a, b] = piece;
    if (run.length === 0) {
      run.push(a);
    } else if (!near(run[run.length - 1], a)) {
      // The line left the box and came back: start a new run rather than
      // bridging the gap with a segment that was never there.
      if (run.length > 1) runs.push(run);
      run = [a];
    }
    run.push(b);
  }
  if (run.length > 1) runs.push(run);

  return runs;
}

function overlaps(points: [number, number][], box: BBox): boolean {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return minLon <= box.maxLon && maxLon >= box.minLon && minLat <= box.maxLat && maxLat >= box.minLat;
}

// --- Overpass ------------------------------------------------------------

interface OsmPoint { lat: number; lon: number }
interface OsmElement {
  type: 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  geometry?: OsmPoint[];
  members?: { type: string; role: string; geometry?: OsmPoint[] }[];
}

/**
 * Join a multipolygon's outer ways into closed rings.
 *
 * Overpass hands back the member ways in no particular order and in no
 * particular direction — the 한강 arrives as ~30 fragments. Each ring is grown
 * from whichever fragment is still unused by repeatedly appending the one
 * whose start or end meets the open end, flipping it when it is the end that
 * matches. A fragment that meets nothing closes the ring as it stands.
 */
function stitchRings(members: { role: string; geometry?: OsmPoint[] }[]): [number, number][][] {
  const parts = members
    .filter((m) => m.role !== 'inner' && m.geometry && m.geometry.length > 1)
    .map((m) => m.geometry!.map((p) => [p.lon, p.lat] as [number, number]));

  const used = new Array(parts.length).fill(false);
  const rings: [number, number][][] = [];
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

  for (let seed = 0; seed < parts.length; seed++) {
    if (used[seed]) continue;
    used[seed] = true;
    const ring = [...parts[seed]];

    let extended = true;
    while (extended) {
      extended = false;
      const tail = ring[ring.length - 1];
      if (same(tail, ring[0])) break; // already closed

      for (let i = 0; i < parts.length; i++) {
        if (used[i]) continue;
        const part = parts[i];
        if (same(part[0], tail)) {
          ring.push(...part.slice(1));
        } else if (same(part[part.length - 1], tail)) {
          ring.push(...part.slice(0, -1).reverse());
        } else {
          continue;
        }
        used[i] = true;
        extended = true;
        break;
      }
    }

    if (ring.length >= 4) rings.push(ring);
  }

  return rings;
}

function ringsFrom(elements: OsmElement[]): [number, number][][] {
  const rings: [number, number][][] = [];
  for (const element of elements) {
    if (element.type === 'way' && element.geometry) {
      rings.push(element.geometry.map((p) => [p.lon, p.lat] as [number, number]));
    } else if (element.type === 'relation' && element.members) {
      rings.push(...stitchRings(element.members));
    }
  }
  return rings;
}

async function fetchWater(box: BBox): Promise<{ rings: [number, number][][]; host: string }> {
  const query = `[out:json][timeout:120];
(
  way["natural"="water"]["water"="river"](${box.minLat},${box.minLon},${box.maxLat},${box.maxLon});
  relation["natural"="water"]["water"="river"](${box.minLat},${box.minLon},${box.maxLat},${box.maxLon});
);
out geom;`;

  const failures: string[] = [];
  for (const host of OVERPASS_HOSTS) {
    let body: { elements: OsmElement[] };
    try {
      const res = await fetch(`${host}/api/interpreter`, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
      });
      // Overpass answers 429/504 when it is busy; the next mirror usually is
      // not. A mirror can also be unreachable outright, which arrives as a
      // thrown TypeError rather than a status — both mean "try the next one".
      if (!res.ok) {
        failures.push(`${host} -> ${res.status} ${res.statusText}`);
        continue;
      }
      body = (await res.json()) as { elements: OsmElement[] };
    } catch (err) {
      failures.push(`${host} -> ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    mkdirSync(RAW_DIR, { recursive: true });
    writeFileSync(WATER_CACHE, JSON.stringify(body));
    return { rings: ringsFrom(body.elements), host };
  }

  // Every mirror is down or unreachable. A cached response is a better answer
  // than no backdrop, as long as it says so rather than passing itself off as
  // a fresh fetch.
  if (existsSync(WATER_CACHE)) {
    const body = JSON.parse(readFileSync(WATER_CACHE, 'utf8')) as { elements: OsmElement[] };
    return { rings: ringsFrom(body.elements), host: `cache raw/osm-water.json (every mirror refused)` };
  }

  throw new Error(`Every Overpass mirror refused and no cached response exists:\n  ${failures.join('\n  ')}`);
}

// --- municipalities ------------------------------------------------------

interface GeoFeature {
  properties: { name?: string };
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
}

async function fetchDistricts(box: BBox): Promise<{ rings: [number, number][][]; names: string[] }> {
  const res = await fetch(MUNICIPALITIES_URL);
  if (!res.ok) throw new Error(`${MUNICIPALITIES_URL} -> ${res.status} ${res.statusText}`);
  const collection = (await res.json()) as { features: GeoFeature[] };

  const rings: [number, number][][] = [];
  const names: string[] = [];

  for (const feature of collection.features) {
    // Outer rings only. A 구's holes are enclaves the eye will never miss at
    // this scale, and drawing them doubles the point count.
    const polygons =
      feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates as number[][][]]
        : (feature.geometry.coordinates as number[][][][]);

    let kept = false;
    for (const polygon of polygons) {
      const ring = polygon[0].map((c) => [c[0], c[1]] as [number, number]);
      if (!overlaps(ring, box)) continue;
      rings.push(ring);
      kept = true;
    }
    if (kept && feature.properties.name) names.push(feature.properties.name);
  }

  return { rings, names };
}

// --- assembly ------------------------------------------------------------

/**
 * Bounding box of the stations already loaded.
 *
 * With no padding this is exactly what the projection maps onto 0..1, so it is
 * also the visible area. Padded, it is the region worth asking Overpass about.
 */
export function networkBBox(coords: Iterable<{ lat: number; lon: number }>, padDeg = 0): BBox {
  const all = [...coords];
  if (all.length === 0) throw new Error('No station coordinates — run `npm run coords` first');
  return {
    minLat: Math.min(...all.map((c) => c.lat)) - padDeg,
    maxLat: Math.max(...all.map((c) => c.lat)) + padDeg,
    minLon: Math.min(...all.map((c) => c.lon)) - padDeg,
    maxLon: Math.max(...all.map((c) => c.lon)) + padDeg,
  };
}

export const QUERY_PAD_DEG = BBOX_PAD_DEG;

/**
 * The viewBox carries an 18-unit margin on a 1000-unit width, so a little more
 * than the station box is actually on screen. 3% covers it on both axes.
 */
function viewBox(stations: BBox): BBox {
  const dLat = (stations.maxLat - stations.minLat) * 0.03;
  const dLon = (stations.maxLon - stations.minLon) * 0.03;
  return {
    minLat: stations.minLat - dLat,
    maxLat: stations.maxLat + dLat,
    minLon: stations.minLon - dLon,
    maxLon: stations.maxLon + dLon,
  };
}

export async function fetchBasemap(stations: BBox): Promise<BasemapReport> {
  const query = networkBBox(
    [
      { lat: stations.minLat, lon: stations.minLon },
      { lat: stations.maxLat, lon: stations.maxLon },
    ],
    BBOX_PAD_DEG,
  );
  const view = viewBox(stations);
  const scaleLon = Math.cos(((query.minLat + query.maxLat) / 2) * (Math.PI / 180));

  const [water, districts] = await Promise.all([fetchWater(query), fetchDistricts(query)]);

  let pointsBeforeSimplify = 0;
  const shapes: BasemapShape[] = [];

  // Water keeps its whole ring. It has to stay closed to be filled, and a
  // polygon clipper on something as concave as a river bank can bridge two
  // distant banks with an edge along the clip line. It reaches barely past the
  // view anyway, so there is little to win.
  for (const ring of water.rings) {
    if (ringSpan(ring) < MIN_WATER_DEG) continue;
    pointsBeforeSimplify += ring.length;
    shapes.push({ kind: 'water', points: simplify(ring, SIMPLIFY_DEG, scaleLon) });
  }

  for (const ring of districts.rings) {
    pointsBeforeSimplify += ring.length;
    for (const run of clipRuns(simplify(ring, SIMPLIFY_DEG, scaleLon), view)) {
      shapes.push({ kind: 'district', points: run });
    }
  }

  if (shapes.length === 0) throw new Error('Fetched no basemap geometry at all');

  return {
    shapes,
    water: shapes.filter((s) => s.kind === 'water').length,
    districts: shapes.filter((s) => s.kind === 'district').length,
    districtNames: districts.names,
    points: shapes.reduce((n, s) => n + s.points.length, 0),
    pointsBeforeSimplify,
    overpassHost: water.host,
  };
}

// --- storage -------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS basemap (
  id     INTEGER PRIMARY KEY,
  kind   TEXT NOT NULL,
  points TEXT NOT NULL
);
`;

export function ensureBasemapSchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
}

export function replaceBasemap(db: DatabaseSync, shapes: BasemapShape[]): number {
  if (shapes.length === 0) throw new Error('Refusing to replace the basemap with zero shapes');
  ensureBasemapSchema(db);

  const insert = db.prepare('INSERT INTO basemap (kind, points) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM basemap');
    // Six decimals is about 0.1m — far finer than the sources and still a third
    // of the size of the raw doubles.
    for (const s of shapes) {
      insert.run(s.kind, JSON.stringify(s.points.map(([lon, lat]) => [+lon.toFixed(6), +lat.toFixed(6)])));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return shapes.length;
}

export function loadBasemap(db: DatabaseSync): BasemapShape[] {
  ensureBasemapSchema(db);
  const rows = db.prepare('SELECT kind, points FROM basemap ORDER BY id').all() as {
    kind: string;
    points: string;
  }[];
  return rows.map((r) => ({
    kind: r.kind as ShapeKind,
    points: JSON.parse(r.points) as [number, number][],
  }));
}
