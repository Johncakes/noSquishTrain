/** Sanity report on whatever is currently in the DB. */
import { openDb, getMeta } from './db.ts';

const db = openDb();

const meta = ['quarter', 'source', 'ingested_at'].map((k) => `${k}=${getMeta(db, k) ?? '-'}`);
console.log(meta.join('  '));

const totals = db.prepare(`
  SELECT COUNT(*) AS rows,
         COUNT(DISTINCT station) AS stations,
         COUNT(DISTINCT line) AS lines,
         COUNT(DISTINCT bucket_min) AS buckets
  FROM congestion
`).get();
console.log(totals);

console.log('\nPer line:');
for (const r of db.prepare(`
  SELECT line,
         COUNT(DISTINCT station_no) AS stations,
         group_concat(DISTINCT direction) AS directions,
         ROUND(MAX(pct), 1) AS peak
  FROM congestion GROUP BY line ORDER BY line
`).all()) {
  console.log(' ', r);
}

console.log('\nWorst 5 weekday legs:');
for (const r of db.prepare(`
  SELECT line, station, direction, bucket, pct
  FROM congestion WHERE day_type = '평일'
  ORDER BY pct DESC LIMIT 5
`).all()) {
  console.log(' ', r);
}

db.close();
