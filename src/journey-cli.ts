/**
 * Evaluate a journey described in a JSON file.
 *
 * This is the shape ODsay will fill in automatically; specifying it by hand
 * lets the whole evaluator be exercised before the API is wired up.
 *
 * Usage: npm run journey -- path/to/journey.json [HH:MM]
 *
 * {
 *   "dayType": "평일",
 *   "legs": [
 *     { "line": "2호선", "board": "신도림", "next": "문래",
 *       "alight": "동대문역사문화공원", "rideMinutes": 24, "transferMinutes": 4 },
 *     { "line": "4호선", "board": "동대문역사문화공원", "next": "충무로",
 *       "alight": "명동", "rideMinutes": 4 }
 *   ]
 * }
 *
 * `next` is the stop immediately after boarding. It is what fixes direction —
 * on a loop line the leg's endpoints cannot.
 */
import { readFileSync } from 'node:fs';
import { openDb } from './db.ts';
import { formatTime, loadCongestion, normalizeDayType, parseTime } from './congestion.ts';
import { congestionStationNo, loadStations, resolveDirection } from './stations.ts';
import { evaluate, recommend, sweepJourney, type JourneyLeg } from './journey.ts';

interface LegSpec {
  line: string;
  board: string;
  next?: string;
  alight: string;
  rideMinutes: number;
  transferMinutes?: number;
  stops?: number;
}

const [specPath, timeArg = '08:00'] = process.argv.slice(2);
if (!specPath) {
  console.error('Usage: npm run journey -- <journey.json> [HH:MM]');
  process.exit(1);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { dayType?: string; legs: LegSpec[] };
const dayType = normalizeDayType(spec.dayType ?? '평일');
const target = parseTime(timeArg);

const db = openDb();
const stations = loadStations(db);
const lookup = loadCongestion(db);

/** Turn the human spec into evaluable legs, resolving direction and data row. */
let offset = 0;
const legs: JourneyLeg[] = spec.legs.map((leg, i) => {
  if (i > 0) offset += leg.transferMinutes ?? 0;
  const boardPlatform = stations.platform(leg.board, leg.line);
  const nextPlatform = leg.next ? stations.platform(leg.next, leg.line) : null;

  // A line outside 1-8, or a station we have no row for, is uncovered — never
  // guessed at. An unscored leg must not be able to look calm.
  const covered = boardPlatform !== null && nextPlatform !== null;
  const built: JourneyLeg = {
    line: leg.line,
    boardStation: leg.board,
    alightStation: leg.alight,
    direction: covered ? resolveDirection(leg.line, boardPlatform!.stationNo, nextPlatform!.stationNo) : null,
    congestionStationNo: covered
      ? congestionStationNo(leg.line, boardPlatform!.stationNo, nextPlatform!.stationNo)
      : null,
    rideMinutes: leg.rideMinutes,
    offsetMinutes: offset,
    covered,
    stops: leg.stops,
  };
  offset += leg.rideMinutes;
  return built;
});

const band = (pct: number | null) =>
  pct === null ? 'no data' :
  pct <= 34 ? 'seat likely' :
  pct <= 70 ? 'room to stand' :
  pct <= 100 ? 'busy' :
  pct <= 130 ? 'PACKED' : 'CRUSH';

function show(label: string, at: number) {
  const evaluation = evaluate(legs, lookup, dayType, at);
  console.log(`\n${label}  depart ${formatTime(at)}  ·  ${evaluation.totalMinutes} min total`);
  for (const r of evaluation.readings) {
    const pct = r.pct === null ? '   —' : `${Math.round(r.pct)}%`.padStart(4);
    console.log(
      `   ${formatTime(r.atMinutes)}  ${r.leg.line.padEnd(4)} ` +
      `${(r.leg.boardStation + ' → ' + r.leg.alightStation).padEnd(28)} ` +
      `${pct}  ${band(r.pct)}${r.leg.covered ? '' : '  (line not in dataset)'}`,
    );
  }
  console.log(`   worst leg ${evaluation.worstPct === null ? '—' : Math.round(evaluation.worstPct) + '%'}`);
}

console.log(`journey: ${legs.map((l) => l.line).join(' → ')}   ${dayType}   [${lookup.quarter}]`);
if (legs.some((l) => !l.covered)) {
  console.log('note: some legs have no published congestion — shown as — , never as 0%.');
}

show('AS PLANNED', target);

const evaluations = sweepJourney(legs, lookup, dayType);
const rec = recommend(evaluations, target);

if (!rec) {
  console.log('\nNo leg of this journey has congestion data; nothing to recommend.');
} else {
  show('BEST ALL DAY', rec.best.departMinutes);
  console.log(`\nworst departure is ${formatTime(rec.worst.departMinutes)} (worst leg ${Math.round(rec.worst.worstPct!)}%)`);
  console.log(`spread across the day: ${Math.round(rec.spread)} points`);

  if (rec.betterNearby) {
    const { evaluation, waitMinutes, pointsSaved } = rec.betterNearby;
    console.log(
      `\nleaving ${waitMinutes} min later (${formatTime(evaluation.departMinutes)}) ` +
      `drops your worst leg by ${Math.round(pointsSaved)} points to ${Math.round(evaluation.worstPct!)}%`,
    );
  } else {
    console.log(`\nno better departure within 2 hours of ${formatTime(target)}.`);
  }

  console.log('\ndepart   ' + legs.map((l) => l.line.padEnd(7)).join('') + 'worst');
  for (const e of evaluations) {
    const cells = e.readings.map((r) => (r.pct === null ? '  —   ' : `${Math.round(r.pct)}%`.padStart(5) + ' ').padEnd(7)).join('');
    const mark = e === rec.best ? ' ←' : '';
    console.log(`${formatTime(e.departMinutes)}    ${cells}${e.worstPct === null ? '  —' : String(Math.round(e.worstPct)).padStart(4) + '%'}${mark}`);
  }
}

db.close();
