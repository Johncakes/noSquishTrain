/**
 * Refresh the congestion table from the data.go.kr open API.
 *
 * By default this discovers the newest published version automatically (see
 * discover.ts) — so when a new quarter drops, re-running this is all that is
 * needed. Set ODCLOUD_UDDI to pin a specific historical version instead.
 *
 * Usage:
 *   npm run ingest              # newest published version
 *   npm run ingest -- --dry-run # fetch + validate, do not write to the DB
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, replaceLines } from './db.ts';
import { expandRecord, FIXED_COLUMNS, type CongestionRow } from './normalize.ts';
import { API_BASE, latestVersion, listVersions, quarterOf, type DatasetVersion } from './discover.ts';

const PER_PAGE = 1000;
const RAW_DIR = join(import.meta.dirname, '..', 'raw');

interface OdcloudPage {
  page: number;
  perPage: number;
  totalCount: number;
  currentCount: number;
  data: Record<string, unknown>[];
}

const dryRun = process.argv.includes('--dry-run');

function serviceKey(): string {
  const v = process.env.ODCLOUD_SERVICE_KEY;
  if (!v) throw new Error('Missing ODCLOUD_SERVICE_KEY. Copy .env.example to .env and fill it in.');
  return v;
}

async function fetchPage(path: string, key: string, page: number): Promise<OdcloudPage> {
  const url = new URL(`${API_BASE}/${path}`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('perPage', String(PER_PAGE));
  url.searchParams.set('returnType', 'json');
  // Portal keys are issued already percent-encoded; routing it through
  // searchParams would double-encode the +, / and = characters.
  const res = await fetch(`${url}&serviceKey=${key}`);

  const body = await res.text();
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);

  try {
    return JSON.parse(body) as OdcloudPage;
  } catch {
    // An invalid key returns an XML error document with HTTP 200.
    throw new Error(`Expected JSON, got: ${body.slice(0, 400)}`);
  }
}

async function fetchAll(version: DatasetVersion, key: string): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const body = await fetchPage(version.path, key, page);
    all.push(...body.data);
    console.log(`  page ${page}: +${body.data.length} (${all.length}/${body.totalCount})`);
    if (body.data.length === 0 || all.length >= body.totalCount) break;
  }
  return all;
}

/** Fail loudly on a shape change rather than silently importing zero rows. */
function assertShape(record: Record<string, unknown>): void {
  const missing = Object.values(FIXED_COLUMNS).filter((c) => !(c in record));
  if (missing.length > 0) {
    throw new Error(
      `API response is missing expected columns: ${missing.join(', ')}\n` +
        `Got: ${Object.keys(record).slice(0, 12).join(', ')}...`,
    );
  }
}

const key = serviceKey();

const pinned = process.env.ODCLOUD_UDDI?.trim();
let version: DatasetVersion;
if (pinned) {
  const match = (await listVersions()).find((v) => v.uddi === pinned);
  if (!match) throw new Error(`ODCLOUD_UDDI ${pinned} is not in the published version list.`);
  version = match;
} else {
  version = await latestVersion();
}

const quarter = process.env.QUARTER?.trim() || quarterOf(version.date);

console.log(`Latest published: ${version.title}`);
console.log(`  ${version.uddi}  ->  ${quarter}`);

const records = await fetchAll(version, key);
if (records.length === 0) throw new Error('API returned no records; refusing to touch existing data.');
assertShape(records[0]);

const rows: CongestionRow[] = records.flatMap(expandRecord);
console.log(`  ${records.length} source records -> ${rows.length} long-format rows`);

if (dryRun) {
  console.log('--dry-run: validated, nothing written.');
} else {
  // Keep the raw response so the normalizer can be re-run or debugged
  // without spending another API call.
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(join(RAW_DIR, `${quarter}.json`), JSON.stringify(records, null, 2));

  const db = openDb();
  const { total } = replaceLines(db, {
    quarter,
    rows,
    source: `odcloud:${version.uddi}`,
    meta: { quarter },
  });
  db.close();

  console.log(`Ingested ${quarter}`);
  console.log(`  raw response saved to raw/${quarter}.json`);
  console.log(`  ${total} rows now in data/congestion.db`);
}
