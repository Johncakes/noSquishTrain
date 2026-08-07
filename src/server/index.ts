/**
 * Local server for the congestion map.
 *
 * Usage: npm run serve   (then open http://localhost:8137)
 *
 * The network and the whole congestion table are built once at startup. A
 * request only serialises what is already in memory, so there is no
 * per-request database work and the day-type switch is instant.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { openDb, getMeta } from '../data/db.ts';
import { loadCoords } from '../data/coords.ts';
import { buildNetwork, slotOf, type Departure } from '../domain/network.ts';
import { buildProjection, placePlatforms } from '../domain/geo.ts';
import { loadCongestion } from '../domain/congestion.ts';
import { BUCKETS, DAY_TYPES, type DayType } from '../shared/scale.ts';
import { SERVICE_SLOTS } from '../shared/types.ts';
import type { CongestionPayload, DirectionSeries, NetworkPayload, ServiceSeries, WirePlatform, WireSegment } from '../shared/types.ts';

const PORT = Number(process.env.PORT ?? 8137);
const WEB_DIR = join(import.meta.dirname, '..', 'web');
const DIST_DIR = join(import.meta.dirname, '..', '..', 'dist');

const db = openDb();
const network = buildNetwork(db);
const coords = loadCoords(db);
const lookup = loadCongestion(db);

if (!lookup.quarter) {
  console.error('No congestion data. Run `npm run ingest` first.');
  process.exit(1);
}
if (coords.size === 0) {
  console.error('No station coordinates. Run `npm run coords` first.');
  process.exit(1);
}

const projection = buildProjection(coords.values());
const placed = placePlatforms(network, coords, projection).sort(
  (a, b) => a.line.localeCompare(b.line) || a.stationNo - b.stationNo,
);
const indexOfKey = new Map(placed.map((p, i) => [p.key, i]));

/**
 * Departures per platform, placed in their fixed display slot rather than
 * packed into a list. Two platforms serving one direction each — 방화 (하선)
 * and 오금 (상선) — would otherwise both occupy slot 0 and be drawn as if they
 * ran the same way.
 */
const departures = placed.map((p) => {
  const slots: [Departure | null, Departure | null] = [null, null];
  for (const d of network.departures(p.key)) {
    const slot = slotOf(d.direction);
    if (slots[slot]) {
      throw new Error(`${p.line} ${p.station}: two departures in slot ${slot} (${slots[slot]!.direction}, ${d.direction})`);
    }
    slots[slot] = d;
  }
  if (!slots[0] && !slots[1]) throw new Error(`${p.line} ${p.station}: no departures at all`);
  return slots;
});

const platforms: WirePlatform[] = placed.map((p, i) => ({
  key: p.key,
  line: p.line,
  station: p.station,
  name: p.name,
  x: p.x,
  y: p.y,
  shared: p.shared,
  slot: p.slot,
  directions: [
    departures[i][0] && { direction: departures[i][0]!.direction, toward: departures[i][0]!.towardName },
    departures[i][1] && { direction: departures[i][1]!.direction, toward: departures[i][1]!.towardName },
  ],
}));

const segments: WireSegment[] = network.segments
  .map((s) => ({
    line: s.line,
    a: indexOfKey.get(`${s.line}:${s.a}`) ?? -1,
    b: indexOfKey.get(`${s.line}:${s.b}`) ?? -1,
  }))
  .filter((s) => s.a >= 0 && s.b >= 0);

const networkPayload: NetworkPayload = {
  quarter: lookup.quarter,
  line9Period: getMeta(db, 'line9_period'),
  coordsVersion: getMeta(db, 'coords_version'),
  aspect: projection.aspect,
  lines: network.lines,
  dayTypes: DAY_TYPES,
  buckets: BUCKETS,
  platforms,
  segments,
};

/**
 * Every reading for every day type, precomputed.
 *
 * 277 platforms x up to 2 directions x 39 buckets x 3 day types is about 65k
 * numbers — small enough to hold and serialise once, which is what makes
 * scrubbing the timeline feel immediate.
 */
const congestionByDay = new Map<DayType, string>();
for (const dayType of DAY_TYPES) {
  const values: DirectionSeries[] = placed.map((p, i) => {
    const forDirection = (d: Departure | null): ServiceSeries | null => {
      if (d === null) return null;
      const present = new Set(lookup.servicesAt(p.line, d.stationNo, d.direction));
      return SERVICE_SLOTS.map((service) =>
        present.has(service)
          ? BUCKETS.map((bucket) => lookup.at(p.line, d.stationNo, d.direction, dayType, bucket, service))
          : null,
      ) as ServiceSeries;
    };
    return [forDirection(departures[i][0]), forDirection(departures[i][1])];
  });
  const payload: CongestionPayload = { dayType, values };
  congestionByDay.set(dayType, JSON.stringify(payload));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const send = (status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(200, readFileSync(join(WEB_DIR, 'index.html')), MIME['.html']);
    }

    if (url.pathname === '/api/network') {
      return send(200, JSON.stringify(networkPayload), 'application/json; charset=utf-8');
    }

    if (url.pathname === '/api/congestion') {
      const day = url.searchParams.get('day') ?? '평일';
      const payload = congestionByDay.get(day as DayType);
      if (!payload) {
        return send(400, JSON.stringify({ error: `Unknown day type '${day}'` }), 'application/json; charset=utf-8');
      }
      return send(200, payload, 'application/json; charset=utf-8');
    }

    // Static assets: compiled modules from dist/, everything else from src/web.
    // The whole dist tree is served, not just dist/web — main.js imports
    // ../shared/scale.js, which lands one level up.
    // normalize() plus the prefix check keeps '..' from escaping either root.
    const relative = url.pathname.replace(/^\//, '');
    const inDist = relative.startsWith('dist/');
    const root = inDist ? DIST_DIR : WEB_DIR;
    const name = inDist ? relative.slice('dist/'.length) : relative;
    const filePath = normalize(join(root, name));
    if (filePath.startsWith(root) && existsSync(filePath)) {
      return send(200, readFileSync(filePath), MIME[extname(filePath)] ?? 'application/octet-stream');
    }

    return send(404, JSON.stringify({ error: 'Not found' }), 'application/json; charset=utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return send(500, JSON.stringify({ error: message }), 'application/json; charset=utf-8');
  }
});

server.listen(PORT, () => {
  console.log(`noSquishTrain map on http://localhost:${PORT}`);
  console.log(`  ${platforms.length} platforms, ${segments.length} segments`);
  console.log(`  congestion ${lookup.quarter}, coordinates ${getMeta(db, 'coords_version')}`);
  if (!existsSync(DIST_DIR)) console.log('  (run `npm run build` first — dist/web is missing)');
});
