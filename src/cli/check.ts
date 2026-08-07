/**
 * Validate the data the map is drawn from.
 *
 * The failure mode this exists for is a map that looks right and is wrong:
 * coordinates joined to the wrong station produce a plausible-looking network
 * with stations in their neighbours' places. Geometry catches that — real
 * adjacent stations are close together, so a bad join shows up as an
 * impossibly long hop.
 *
 * Usage: npm run check
 */
import { openDb } from '../data/db.ts';
import { loadCoords } from '../data/coords.ts';
import { buildNetwork, platformKey } from '../domain/network.ts';
import { haversine } from '../domain/geo.ts';
import { loadCongestion } from '../domain/congestion.ts';

const db = openDb();
const network = buildNetwork(db);
const coords = loadCoords(db);
const lookup = loadCongestion(db);

let failures = 0;
const check = (name: string, problems: string[], detail = 6) => {
  if (problems.length === 0) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${name} — ${problems.length} problem(s)`);
  for (const p of problems.slice(0, detail)) console.log(`          ${p}`);
  if (problems.length > detail) console.log(`          … and ${problems.length - detail} more`);
};

console.log(`network: ${network.platforms.length} platforms, ${network.segments.length} track segments, ${network.lines.length} lines`);
console.log(`data:    congestion ${lookup.quarter}, ${coords.size} coordinates\n`);

// 1. Every drawable platform has a position.
check(
  'every platform has a coordinate',
  network.platforms.filter((p) => !coords.has(p.key)).map((p) => `${p.line} ${p.stationNo} ${p.station}`),
);

// 2. Track connects stations that exist.
check(
  'every segment connects known platforms',
  network.segments.flatMap((s) =>
    [s.a, s.b]
      .filter((no) => !network.byKey.has(platformKey(s.line, no)))
      .map((no) => `${s.line} segment ${s.a}-${s.b}: ${no} is not a platform`),
  ),
);

// 3. Adjacent stations are physically close.
//
// This is the check that catches a bad coordinate join. Seoul's longest real
// inter-station gap on lines 1-8 is around 3km; the 6호선 shift would have put
// 봉화산 17km from its neighbour.
const LONG_HOP_M = 5_000;
const hops = network.segments
  .map((s) => {
    const a = coords.get(platformKey(s.line, s.a));
    const b = coords.get(platformKey(s.line, s.b));
    if (!a || !b) return null;
    return { s, m: haversine(a.lat, a.lon, b.lat, b.lon) };
  })
  .filter((h): h is NonNullable<typeof h> => h !== null);

check(
  `adjacent stations are within ${LONG_HOP_M / 1000}km`,
  hops
    .filter((h) => h.m > LONG_HOP_M)
    .sort((x, y) => y.m - x.m)
    .map((h) => {
      const a = network.byKey.get(platformKey(h.s.line, h.s.a));
      const b = network.byKey.get(platformKey(h.s.line, h.s.b));
      return `${h.s.line} ${a?.name} -> ${b?.name}: ${(h.m / 1000).toFixed(1)}km`;
    }),
);

// 4. Platforms of one interchange sit at one place.
const nameProblems: string[] = [];
for (const [name, platforms] of network.byName) {
  if (platforms.length < 2) continue;
  const points = platforms.map((p) => coords.get(p.key)).filter((c) => c !== undefined);
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[0]!.lat, points[0]!.lon, points[i]!.lat, points[i]!.lon);
    // Interchanges with long underground walks (동대문역사문화공원, 종로3가)
    // still publish per-line coordinates a few hundred metres apart.
    if (d > 1_000) nameProblems.push(`${name}: ${platforms[0].line} and ${platforms[i].line} are ${Math.round(d)}m apart`);
  }
}
check('interchange platforms share a location', nameProblems);

// 5. Every platform has a departure the map can colour.
//
// A platform with no readable congestion would render as a permanent blank —
// indistinguishable at a glance from a calm one unless it is handled explicitly.
const unreadable: string[] = [];
for (const platform of network.platforms) {
  const departures = network.departures(platform.key);
  if (departures.length === 0) {
    unreadable.push(`${platform.line} ${platform.station}: no departures`);
    continue;
  }
  const anyData = departures.some((d) =>
    ['평일', '토요일', '일요일'].some((day) =>
      lookup.at(platform.line, d.stationNo, d.direction, day, 480) !== null,
    ),
  );
  if (!anyData) unreadable.push(`${platform.line} ${platform.station}: no congestion for any departure`);
}
check('every platform has readable congestion', unreadable);

// 6. No departure reads an all-zero row.
//
// A station serving two services records the second under a synthetic 9xxx row
// and leaves its own row at 0. Reading the wrong one reports an empty train.
const zeroRows: string[] = [];
for (const platform of network.platforms) {
  for (const d of network.departures(platform.key)) {
    let sum = 0;
    let seen = 0;
    for (let t = 330; t <= 1470; t += 30) {
      const v = lookup.at(platform.line, d.stationNo, d.direction, '평일', t);
      if (v !== null) { sum += v; seen++; }
    }
    if (seen > 0 && sum === 0) {
      zeroRows.push(`${platform.line} ${platform.station} ${d.direction} (row ${d.stationNo}) is 0 all day`);
    }
  }
}
check('no departure reads an all-zero row', zeroRows);

console.log(failures === 0 ? '\nall checks passed.' : `\n${failures} check(s) failed.`);
db.close();
process.exit(failures === 0 ? 0 : 1);
