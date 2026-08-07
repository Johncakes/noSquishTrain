/**
 * Ingest 9호선 congestion from the published spreadsheet.
 *
 * Usage: npm run line9 [-- path/to/file.xlsx] [--dry-run]
 *
 * There is no API for 9호선, so the file has to be downloaded by hand from
 * 서울 열린데이터광장 and dropped in raw/. Everything else about it is
 * automatic.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, replaceLines } from '../data/db.ts';
import { LINE9, readLine9 } from '../data/line9.ts';

const RAW_DIR = join(import.meta.dirname, '..', '..', 'raw');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
let path = args.find((a) => !a.startsWith('--'));

if (!path) {
  const candidates = readdirSync(RAW_DIR).filter((f) => f.endsWith('.xlsx') && f.includes('9호선'));
  if (candidates.length === 0) {
    console.error(`No 9호선 .xlsx found in raw/. Put the published file there, or pass a path.`);
    process.exit(1);
  }
  // Newest name last: the files are titled by year.
  path = join(RAW_DIR, candidates.sort().at(-1)!);
  console.log(`using ${candidates.at(-1)}`);
}

const report = readLine9(path);

/**
 * The period the file measures, from its own 기준일자 note rather than from the
 * filename — the 2025 file is measured in November, so calling it 2025Q1 on
 * the strength of its title would misdate it by three quarters.
 */
function periodOf(basis: string[]): string {
  const dates = basis.flatMap((b) => [...b.matchAll(/`?(\d{2})\.(\d{1,2})\./g)].map((m) => ({
    year: 2000 + Number(m[1]),
    month: Number(m[2]),
  })));
  if (dates.length === 0) return 'unknown';
  const { year, month } = dates[0];
  return `${year}Q${Math.ceil(month / 3)}`;
}

const period = periodOf(report.basis);

console.log(`\n${report.sheets.length} sheets: ${report.sheets.join(', ')}`);
console.log(`${report.stations.length} stations, ${LINE9} 역번호 901–${900 + report.stations.length}`);
console.log(`period ${period}`);
for (const b of report.basis) console.log(`  ${b}`);

const counts = new Set(Object.values(report.bucketCounts));
if (counts.size > 1) {
  console.log('\ntime buckets differ per sheet — the shorter ones simply have no late-night service:');
  for (const [sheet, n] of Object.entries(report.bucketCounts)) console.log(`   ${sheet.padEnd(18)} ${n}`);
}

if (report.droppedAllZero.length) {
  console.log(`\n${report.droppedAllZero.length} series dropped as all-zero (a terminus, not an empty train):`);
  for (const d of report.droppedAllZero) console.log(`   ${d}`);
}

const byService = new Map<string, number>();
const byDay = new Map<string, number>();
for (const r of report.rows) {
  byService.set(r.service, (byService.get(r.service) ?? 0) + 1);
  byDay.set(r.dayType, (byDay.get(r.dayType) ?? 0) + 1);
}
console.log(`\n${report.rows.length} rows`);
for (const [s, n] of byService) console.log(`   ${s}  ${n}`);
for (const [d, n] of byDay) console.log(`   ${d}  ${n}`);
console.log('   note: 휴일 is one measurement written to both 토요일 and 일요일 — the file publishes no separate Saturday and Sunday.');

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

const db = openDb();
const { written, total } = replaceLines(db, {
  quarter: period,
  rows: report.rows,
  source: `xlsx:${path.split('/').at(-1)}`,
  meta: { line9_period: period, line9_basis: report.basis.join(' ') },
});
db.close();

console.log(`\nwrote ${written} ${LINE9} rows; ${total} rows now in data/congestion.db`);
