/**
 * One-time seed from the downloaded quarterly CSV, so there is a working
 * dataset to develop against before the open-API key is wired up.
 *
 * `npm run ingest` replaces whatever this produces.
 *
 * Usage: npm run seed [-- path/to/file.csv]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openDb, replaceQuarter } from './db.ts';
import { expandRecord, type CongestionRow } from './normalize.ts';

const PROJECT_ROOT = join(import.meta.dirname, '..');

/** '..._20260331.csv' -> '2026Q1' (the file is stamped with the quarter END date). */
function quarterFromFilename(file: string): string {
  const m = basename(file).match(/(\d{4})(\d{2})(\d{2})/);
  if (!m) throw new Error(`Cannot derive quarter from filename: ${file}`);
  const year = m[1];
  const month = Number(m[2]);
  return `${year}Q${Math.ceil(month / 3)}`;
}

function findCsv(): string {
  const hit = readdirSync(PROJECT_ROOT).find((f) => f.endsWith('.csv') && f.includes('혼잡도'));
  if (!hit) throw new Error('No congestion CSV found in project root. Pass a path explicitly.');
  return join(PROJECT_ROOT, hit);
}

/**
 * The published file is CP949 with no quoted fields or embedded commas, so a
 * plain split is sufficient. 'euc-kr' is the WHATWG label that covers CP949.
 */
function parseCsv(path: string): Record<string, string>[] {
  const text = new TextDecoder('euc-kr').decode(readFileSync(path));
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0].split(',').map((h) => h.trim());

  return lines.slice(1).map((line, i) => {
    const cells = line.split(',');
    if (cells.length !== header.length) {
      throw new Error(`Row ${i + 2}: expected ${header.length} cells, got ${cells.length}`);
    }
    return Object.fromEntries(header.map((h, j) => [h, cells[j]]));
  });
}

const csvPath = process.argv[2] ?? findCsv();
const quarter = quarterFromFilename(csvPath);

const records = parseCsv(csvPath);
const rows: CongestionRow[] = records.flatMap(expandRecord);

const db = openDb();
const total = replaceQuarter(db, quarter, rows, `csv:${basename(csvPath)}`);
db.close();

console.log(`Seeded ${quarter} from ${basename(csvPath)}`);
console.log(`  ${records.length} source records -> ${rows.length} long-format rows`);
console.log(`  ${total} rows now in data/congestion.db`);
