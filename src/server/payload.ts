/**
 * Everything the page needs, built once from the database.
 *
 * Two callers: `npm run serve` holds the result in memory, and `npm run export`
 * writes it to disk as the static site. Both go through here so the JSON
 * committed for deployment cannot drift from what the local server shows.
 *
 * Nothing here depends on a request. The dataset changes quarterly, so the
 * whole thing is a pure function of the database and is built exactly once.
 */
import { openDb, getMeta } from '../data/db.ts';
import { loadCoords } from '../data/coords.ts';
import { loadBasemap } from '../data/basemap.ts';
import { buildNetwork, slotOf, type Departure } from '../domain/network.ts';
import { buildProjection, placePlatforms } from '../domain/geo.ts';
import { loadCongestion } from '../domain/congestion.ts';
import { BUCKETS, DAY_TYPES } from '../shared/scale.ts';
import { NETWORK_PATH, SERVICE_SLOTS, congestionPath } from '../shared/types.ts';
import type { CongestionPayload, DirectionSeries, NetworkPayload, ServiceSeries, WirePlatform, WireSegment, WireShape } from '../shared/types.ts';

export interface Payloads {
  network: NetworkPayload;
  /**
   * Already serialised, keyed by the URL it is served at. Both callers only
   * ever write these out as bytes, so they are stringified once here rather
   * than once per request and again per export.
   */
  byPath: Map<string, string>;
}

/**
 * Throws with an actionable message when the database is not ready — an empty
 * map with no explanation is worse than a failed command.
 */
export function buildPayloads(): Payloads {
  const db = openDb();
  const network = buildNetwork(db);
  const coords = loadCoords(db);
  const lookup = loadCongestion(db);

  if (!lookup.quarter) throw new Error('No congestion data. Run `npm run ingest` first.');
  if (coords.size === 0) throw new Error('No station coordinates. Run `npm run coords` first.');

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

  /**
   * The backdrop, through the same projection as the stations.
   *
   * Five decimals in 0..1 space is 0.01 of a view unit — a hundredth of a pixel
   * at full zoom, and it roughly halves the payload against raw doubles.
   */
  const basemap: WireShape[] = loadBasemap(db).map((shape) => ({
    kind: shape.kind,
    points: shape.points.map(([lon, lat]) => {
      const p = projection.project(lat, lon);
      return [+p.x.toFixed(5), +p.y.toFixed(5)] as [number, number];
    }),
  }));

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
    basemap,
  };

  const byPath = new Map<string, string>([[NETWORK_PATH, JSON.stringify(networkPayload)]]);

  /**
   * Every reading for every day type, precomputed.
   *
   * 315 platforms x up to 2 directions x 39 buckets x 3 day types is about 65k
   * numbers — small enough to hold and serialise once, which is what makes
   * scrubbing the timeline feel immediate and the whole site fit in static files.
   */
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
    byPath.set(congestionPath(dayType), JSON.stringify(payload));
  }

  return { network: networkPayload, byPath };
}
