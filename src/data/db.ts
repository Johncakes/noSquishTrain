import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CongestionRow } from './normalize.ts';

export const DB_PATH = join(import.meta.dirname, '..', '..', 'data', 'congestion.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS congestion (
  quarter    TEXT    NOT NULL,
  day_type   TEXT    NOT NULL,
  line       TEXT    NOT NULL,
  station_no INTEGER NOT NULL,
  station    TEXT    NOT NULL,
  direction  TEXT    NOT NULL,
  service    TEXT    NOT NULL DEFAULT '일반',
  bucket     TEXT    NOT NULL,
  bucket_min INTEGER NOT NULL,
  pct        REAL    NOT NULL,
  PRIMARY KEY (quarter, day_type, line, station_no, direction, service, bucket_min)
) WITHOUT ROWID;

-- Graph building walks line -> ordered station numbers.
CREATE INDEX IF NOT EXISTS idx_congestion_line_station
  ON congestion (line, station_no);

-- Name lookup for transfers (same station name, different line).
CREATE INDEX IF NOT EXISTS idx_congestion_station
  ON congestion (station);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Distinct graph nodes, derived rather than stored separately so it can
-- never drift out of sync with the congestion rows.
CREATE VIEW IF NOT EXISTS stations AS
  SELECT DISTINCT line, station_no, station FROM congestion;
`;

export function openDb(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  db.exec(SCHEMA);
  return db;
}

/**
 * Bring an older database up to the current shape.
 *
 * `service` joined the primary key when 9호선 arrived with its 급행 sheets, and
 * SQLite cannot alter a primary key in place. Everything in this table is
 * re-derivable from the sources, so the honest move is to drop it and say so
 * rather than to leave a half-migrated table that silently loses 급행 rows.
 */
function migrate(db: DatabaseSync): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('congestion')").all() as { name: string }[];
  if (columns.length === 0) return; // fresh database
  if (columns.some((c) => c.name === 'service')) return;

  db.exec('DROP VIEW IF EXISTS stations');
  db.exec('DROP TABLE IF EXISTS congestion');
  db.prepare("DELETE FROM meta WHERE key IN ('quarter', 'source', 'ingested_at')").run();
  console.warn('congestion table rebuilt for the new service column — re-run `npm run ingest` and `npm run line9`.');
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Replace every row for the lines this batch covers.
 *
 * Scoped by line, not by quarter. The two sources cover different lines AND
 * different periods — 1-8 is republished quarterly, 9호선 is a one-off file
 * measured in a single week — so a wholesale "delete anything from another
 * quarter" swap would have made re-ingesting lines 1-8 silently delete 9호선.
 *
 * Running this twice with the same data is a no-op, so re-ingest is safe to
 * retry.
 */
export function replaceLines(
  db: DatabaseSync,
  options: { quarter: string; rows: CongestionRow[]; source: string; meta?: Record<string, string> },
): { written: number; total: number } {
  const { quarter, rows, source } = options;
  if (rows.length === 0) throw new Error(`Refusing to replace ${quarter} with zero rows`);

  const lines = [...new Set(rows.map((r) => r.line))];

  const insert = db.prepare(`
    INSERT INTO congestion
      (quarter, day_type, line, station_no, station, direction, service, bucket, bucket_min, pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET pct = excluded.pct, station = excluded.station, bucket = excluded.bucket
  `);

  db.exec('BEGIN');
  try {
    const placeholders = lines.map(() => '?').join(', ');
    db.prepare(`DELETE FROM congestion WHERE line IN (${placeholders})`).run(...lines);
    for (const r of rows) {
      insert.run(
        quarter, r.dayType, r.line, r.stationNo, r.station,
        r.direction, r.service, r.bucket, r.bucketMin, r.pct,
      );
    }
    setMeta(db, 'source', source);
    setMeta(db, 'ingested_at', new Date().toISOString());
    for (const [key, value] of Object.entries(options.meta ?? {})) setMeta(db, key, value);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM congestion').get() as { n: number };
  return { written: rows.length, total: n };
}
