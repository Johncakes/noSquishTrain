/**
 * Fetch station coordinates and store them alongside the congestion data.
 *
 * Usage: npm run coords [-- --dry-run]
 */
import { openDb, setMeta } from '../data/db.ts';
import { fetchCoords, replaceCoords } from '../data/coords.ts';

const dryRun = process.argv.includes('--dry-run');
const serviceKey = process.env.ODCLOUD_SERVICE_KEY;
if (!serviceKey) {
  console.error('ODCLOUD_SERVICE_KEY is not set. Put it in .env (see .env.example).');
  process.exit(1);
}

const db = openDb();
const report = await fetchCoords(db, serviceKey);

console.log(`coordinate file ${report.version} — ${report.coords.length} stations resolved`);

if (report.overrides.length) {
  console.log(`\n${report.overrides.length} coordinate(s) taken from OVERRIDES instead of the file:`);
  for (const o of report.overrides) console.log(`   ${o.key.padEnd(20)} ${o.why}`);
}

const stale = [...report.unusedRenames, ...report.unusedOverrides];
if (stale.length) {
  console.log(`\n${stale.length} table entr(ies) no longer matched anything:`);
  for (const k of stale) console.log(`   ${k}  — the file may have caught up; consider removing`);
}

/**
 * Numbering disagreements already understood. Anything outside this set means
 * the coordinate file renumbered a line we were not expecting, and a map joined
 * on numbers would be wrong in a way nothing else would catch.
 */
const KNOWN_RENUMBERED: Record<string, { count: number; note: string }> = {
  '6호선': { count: 34, note: '봉화산 filed at 2615 instead of 2648, shifting 연신내 onward by one' },
  '2호선': { count: 1, note: '까치산 filed at 200 instead of 260' },
};

if (report.numberMismatches.length) {
  const byLine = new Map<string, number>();
  for (const m of report.numberMismatches) byLine.set(m.line, (byLine.get(m.line) ?? 0) + 1);

  let unexpected = 0;
  console.log(`\n${report.numberMismatches.length} station(s) numbered differently in the coordinate file:`);
  for (const [line, n] of [...byLine].sort()) {
    const known = KNOWN_RENUMBERED[line];
    if (known && known.count === n) {
      console.log(`   ${line}  ${String(n).padStart(3)}  known — ${known.note}`);
    } else {
      unexpected++;
      console.log(`   ${line}  ${String(n).padStart(3)}  *** UNEXPECTED *** (expected ${known?.count ?? 0})`);
      for (const m of report.numberMismatches.filter((x) => x.line === line).slice(0, 5)) {
        console.log(`        ${m.station}: ours ${m.ours}, file ${m.theirs}`);
      }
    }
  }
  console.log('   Joined by name, so positions are correct regardless.');

  if (unexpected) {
    console.error(`\n${unexpected} line(s) changed numbering unexpectedly — review before trusting the map.`);
    process.exitCode = 1;
  }
}

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  db.close();
  process.exit(0);
}

const written = replaceCoords(db, report.coords);
setMeta(db, 'coords_version', report.version);
setMeta(db, 'coords_ingested_at', new Date().toISOString());
console.log(`\nwrote ${written} coordinates.`);
db.close();
