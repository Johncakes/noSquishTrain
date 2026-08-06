import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CongestionRow } from './normalize.ts';

export const DB_PATH = join(import.meta.dirname, '..', 'data', 'congestion.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS congestion (
  quarter    TEXT    NOT NULL,
  day_type   TEXT    NOT NULL,
  line       TEXT    NOT NULL,
  station_no INTEGER NOT NULL,
  station    TEXT    NOT NULL,
  direction  TEXT    NOT NULL,
  bucket     TEXT    NOT NULL,
  bucket_min INTEGER NOT NULL,
  pct        REAL    NOT NULL,
  PRIMARY KEY (quarter, day_type, line, station_no, direction, bucket_min)
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
  db.exec(SCHEMA);
  return db;
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
 * Replace the entire table with one quarter's rows.
 *
 * We only ever keep the latest quarter, so a refresh is a wholesale swap:
 * rows from any other quarter are dropped. Running this twice with the same
 * data is a no-op, which makes re-ingest safe to retry.
 */
export function replaceQuarter(db: DatabaseSync, quarter: string, rows: CongestionRow[], source: string): number {
  if (rows.length === 0) throw new Error(`Refusing to replace ${quarter} with zero rows`);

  const insert = db.prepare(`
    INSERT INTO congestion
      (quarter, day_type, line, station_no, station, direction, bucket, bucket_min, pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET pct = excluded.pct, station = excluded.station, bucket = excluded.bucket
  `);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM congestion WHERE quarter <> ?').run(quarter);
    for (const r of rows) {
      insert.run(quarter, r.dayType, r.line, r.stationNo, r.station, r.direction, r.bucket, r.bucketMin, r.pct);
    }
    setMeta(db, 'quarter', quarter);
    setMeta(db, 'source', source);
    setMeta(db, 'ingested_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM congestion').get() as { n: number };
  return n;
}
