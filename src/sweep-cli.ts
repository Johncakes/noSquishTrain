/**
 * Usage: npm run sweep -- <origin> <dest> [dayType] [fromTime] [toTime]
 *   npm run sweep -- 방화 마천
 *   npm run sweep -- 서울역 잠실 평일 07:00 10:00
 */
import { openDb } from './db.ts';
import { buildGraph, findStation } from './graph.ts';
import { formatTime, loadCongestion, normalizeDayType, parseTime } from './congestion.ts';
import { flexibilityAdvice, summarize, sweep } from './sweep.ts';
import { badge } from './score.ts';

const [origin, dest, dayTypeArg = '평일', fromArg, toArg] = process.argv.slice(2);
if (!origin || !dest) {
  console.error('Usage: npm run sweep -- <origin> <dest> [평일|토요일|일요일] [HH:MM] [HH:MM]');
  process.exit(1);
}

const dayType = normalizeDayType(dayTypeArg);
const db = openDb();
const graph = buildGraph(db);
const lookup = loadCongestion(db);

for (const [label, name] of [['origin', origin], ['destination', dest]] as const) {
  if (findStation(graph, name).length === 0) {
    console.error(`Unknown ${label}: ${name}`);
    process.exit(1);
  }
}

const entries = sweep(graph, lookup, origin, dest, dayType, {
  from: fromArg ? parseTime(fromArg) : undefined,
  to: toArg ? parseTime(toArg) : undefined,
});

const summary = summarize(entries);
if (!summary) {
  console.log('No route found at any departure time.');
  db.close();
  process.exit(0);
}

console.log(`${origin} → ${dest}   ${dayType}   [${lookup.quarter ?? 'no data'}]\n`);

const peaks = entries.map((e) => e.route.peakPct ?? 0);
const scale = Math.max(...peaks, 1);
const signatures = new Map<string, number>();

console.log('depart   time  feels  peak   route');
for (const entry of entries) {
  const { route } = entry;
  if (!signatures.has(entry.signature)) signatures.set(entry.signature, signatures.size + 1);

  const peak = route.peakPct ?? 0;
  const bar = '█'.repeat(Math.round((peak / scale) * 24)).padEnd(24);
  const mark = entry === summary.best ? '←' : ' ';

  console.log(
    `${formatTime(entry.departMinutes)}   ` +
      `${String(route.totalMinutes).padStart(3)}m  ` +
      `${String(Math.round(route.perceivedMinutes)).padStart(4)}m  ` +
      `${String(Math.round(peak)).padStart(4)}%  ` +
      `${bar} [${badge(route.peakPct).trim()}] #${signatures.get(entry.signature)} ${mark}`,
  );
}

console.log(`\nbest departure   ${formatTime(summary.best.departMinutes)}  ` +
  `${summary.best.route.totalMinutes}m, feels like ${Math.round(summary.best.route.perceivedMinutes)}m, ` +
  `peak ${Math.round(summary.best.route.peakPct ?? 0)}%`);
console.log(`worst departure  ${formatTime(summary.worst.departMinutes)}  ` +
  `${summary.worst.route.totalMinutes}m, feels like ${Math.round(summary.worst.route.perceivedMinutes)}m, ` +
  `peak ${Math.round(summary.worst.route.peakPct ?? 0)}%`);
console.log(`spread ${Math.round(summary.spread)} perceived minutes across the day, ` +
  `${summary.distinctRoutes} distinct route(s)`);

// Planning advice around the usual commute peaks.
for (const target of [parseTime('08:00'), parseTime('18:00')]) {
  const advice = flexibilityAdvice(entries, target);
  if (!advice) continue;
  const { now, best, waitMinutes, perceivedSaved, worthWaiting } = advice;
  console.log(
    `\naround ${formatTime(target)}: leaving ${waitMinutes} min later (${formatTime(best.departMinutes)}) ` +
      `drops the peak from ${Math.round(now.route.peakPct ?? 0)}% to ${Math.round(best.route.peakPct ?? 0)}% ` +
      `and saves ${Math.round(perceivedSaved)} perceived min.`,
  );
  console.log(
    worthWaiting
      ? '  worth waiting even at the station.'
      : '  worth planning for, but not worth waiting at the station.',
  );
}

if (signatures.size > 1) {
  console.log('\nroute numbers change when the best path changes; run `npm run plan` at a given time for detail.');
}

db.close();
