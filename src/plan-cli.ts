/**
 * Ranked route options for a trip.
 *
 * Usage: npm run plan -- <origin> <dest> [dayType] [HH:MM]
 *   npm run plan -- 서울역 잠실
 *   npm run plan -- 방화 마천 평일 08:00
 */
import { openDb } from './db.ts';
import { buildGraph, findStation } from './graph.ts';
import { findRoute } from './route.ts';
import {
  formatTime, isOutsideService, loadCongestion, nearestBucket, normalizeDayType, parseTime,
} from './congestion.ts';
import {
  badge, makeCostFn, routeSignature, scoreRoute, type ScoreContext, type ScoredRoute,
} from './score.ts';

const [origin, dest, dayTypeArg = '평일', timeArg = '08:00'] = process.argv.slice(2);
if (!origin || !dest) {
  console.error('Usage: npm run plan -- <origin> <dest> [평일|토요일|일요일] [HH:MM]');
  process.exit(1);
}

const dayType = normalizeDayType(dayTypeArg);
const startMinutes = parseTime(timeArg);

const db = openDb();
const graph = buildGraph(db);
const lookup = loadCongestion(db);

for (const [label, name] of [['origin', origin], ['destination', dest]] as const) {
  if (findStation(graph, name).length === 0) {
    console.error(`Unknown ${label}: ${name}`);
    console.error('This dataset covers Seoul Metro lines 1-8 only (and just 서울역~청량리 on line 1).');
    process.exit(1);
  }
}

console.log(`${origin} → ${dest}   ${dayType} ${formatTime(startMinutes)}   [${lookup.quarter ?? 'no data'}]`);
if (isOutsideService(startMinutes)) {
  console.log(`note: outside service hours; using the ${formatTime(nearestBucket(startMinutes))} bucket.`);
}

/** Same trip, three attitudes to crowding. */
const PROFILES: { name: string; aversion: number }[] = [
  { name: 'fastest', aversion: 0 },
  { name: 'balanced', aversion: 1 },
  { name: 'least crowded', aversion: 3 },
];

const seen = new Map<string, { names: string[]; route: ScoredRoute }>();

for (const profile of PROFILES) {
  const ctx: ScoreContext = { graph, lookup, dayType, startMinutes, aversion: profile.aversion };
  const found = findRoute(graph, origin, dest, makeCostFn(ctx));
  if (!found) continue;

  // Always report congestion on the default curve, so options stay comparable
  // even though each was *searched* under a different weighting.
  const reporting: ScoreContext = { ...ctx, aversion: 1 };
  const scored = scoreRoute(reporting, found);

  const sig = routeSignature(found);
  const existing = seen.get(sig);
  if (existing) existing.names.push(profile.name);
  else seen.set(sig, { names: [profile.name], route: scored });
}

if (seen.size === 0) {
  console.log('\nNo route found.');
  db.close();
  process.exit(0);
}

const options = [...seen.values()].sort((a, b) => a.route.perceivedMinutes - b.route.perceivedMinutes);

for (const { names, route } of options) {
  console.log(`\n── ${names.join(' / ')}`);
  console.log(
    `   ${route.totalMinutes} min` +
      `, feels like ${route.perceivedMinutes.toFixed(0)} min` +
      `, ${route.transfers} transfer(s)` +
      (route.peakPct !== null ? `, peak ${route.peakPct.toFixed(0)}%` : ''),
  );

  for (const leg of route.legs) {
    if (leg.kind === 'transfer') {
      console.log(`     ~ transfer ${leg.line} at ${leg.from} (${leg.minutes}min)`);
      continue;
    }
    const depart = formatTime(startMinutes + leg.offset);
    const mean = leg.meanPct === null ? ' ?' : `${leg.meanPct.toFixed(0)}%`;
    const peak = leg.peakPct === null ? ' ?' : `${leg.peakPct.toFixed(0)}%`;
    console.log(
      `     [${badge(leg.peakPct)}] ${depart} ${leg.line} ${leg.direction}  ` +
        `${leg.from} → ${leg.to}  ${leg.stops} stops ${leg.minutes}min  avg ${mean} peak ${peak}`,
    );
  }

  if (route.unknownMinutes > 0) {
    console.log(`     note: ${route.unknownMinutes} min of this route has no congestion data.`);
  }
}

if (options.length === 1) {
  console.log('\n(only one route — every profile picked the same path)');
}

db.close();
