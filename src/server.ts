/**
 * Local HTTP server for the route planner UI.
 *
 * Usage: npm run serve  (then open http://localhost:8137)
 *
 * The graph and congestion table are built once at startup and reused; a
 * request only runs the search. Everything is served from memory, so there is
 * no per-request database work.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { buildGraph, findStation } from './graph.ts';
import {
  DAY_TYPES, formatTime, isOutsideService, loadCongestion, nearestBucket, normalizeDayType, parseTime,
} from './congestion.ts';
import { planTrip } from './plan.ts';
import { flexibilityAdvice, summarize, sweep } from './sweep.ts';

const PORT = Number(process.env.PORT ?? 8137);
const INDEX_PATH = join(import.meta.dirname, 'web', 'index.html');

const db = openDb();
const graph = buildGraph(db);
const lookup = loadCongestion(db);

if (!lookup.quarter) {
  console.error('No congestion data. Run `npm run seed` or `npm run ingest` first.');
  process.exit(1);
}

/** Station list for the autocomplete, with the lines serving each. */
const stations = [...graph.byName.entries()]
  .map(([name, platforms]) => ({ name, lines: [...new Set(platforms.map((p) => p.line))].sort() }))
  .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

class BadRequest extends Error {}

function requireStation(value: string | null, label: string): string {
  if (!value) throw new BadRequest(`Missing ${label}`);
  if (findStation(graph, value).length === 0) throw new BadRequest(`Unknown station: ${value}`);
  return value;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const send = (status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const json = (status: number, value: unknown) => send(status, JSON.stringify(value), 'application/json; charset=utf-8');

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // Read per request so editing the page does not need a restart.
      return send(200, readFileSync(INDEX_PATH), 'text/html; charset=utf-8');
    }

    if (url.pathname === '/api/stations') {
      return json(200, { stations, dayTypes: DAY_TYPES, quarter: lookup.quarter });
    }

    if (url.pathname === '/api/plan') {
      const from = requireStation(url.searchParams.get('from'), 'from');
      const to = requireStation(url.searchParams.get('to'), 'to');
      const dayType = normalizeDayType(url.searchParams.get('day') ?? '평일');
      const startMinutes = parseTime(url.searchParams.get('time') ?? '08:00');

      return json(200, {
        quarter: lookup.quarter,
        dayType,
        departMinutes: startMinutes,
        departLabel: formatTime(startMinutes),
        outsideService: isOutsideService(startMinutes),
        bucketLabel: formatTime(nearestBucket(startMinutes)),
        options: planTrip(graph, lookup, from, to, dayType, startMinutes),
      });
    }

    if (url.pathname === '/api/sweep') {
      const from = requireStation(url.searchParams.get('from'), 'from');
      const to = requireStation(url.searchParams.get('to'), 'to');
      const dayType = normalizeDayType(url.searchParams.get('day') ?? '평일');
      const target = url.searchParams.get('time') ? parseTime(url.searchParams.get('time')!) : null;

      const entries = sweep(graph, lookup, from, to, dayType);
      const summary = summarize(entries);

      return json(200, {
        quarter: lookup.quarter,
        dayType,
        entries: entries.map((e) => ({
          departMinutes: e.departMinutes,
          departLabel: formatTime(e.departMinutes),
          totalMinutes: e.route.totalMinutes,
          perceivedMinutes: e.route.perceivedMinutes,
          peakPct: e.route.peakPct,
          transfers: e.route.transfers,
          signature: e.signature,
        })),
        best: summary && { departMinutes: summary.best.departMinutes, departLabel: formatTime(summary.best.departMinutes) },
        worst: summary && { departMinutes: summary.worst.departMinutes, departLabel: formatTime(summary.worst.departMinutes) },
        spread: summary?.spread ?? 0,
        distinctRoutes: summary?.distinctRoutes ?? 0,
        advice: target === null ? null : (() => {
          const a = flexibilityAdvice(entries, target);
          return a && {
            nowLabel: formatTime(a.now.departMinutes),
            bestLabel: formatTime(a.best.departMinutes),
            waitMinutes: a.waitMinutes,
            perceivedSaved: a.perceivedSaved,
            worthWaiting: a.worthWaiting,
            nowPeak: a.now.route.peakPct,
            bestPeak: a.best.route.peakPct,
          };
        })(),
      });
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(err instanceof BadRequest ? 400 : 500, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`noSquishTrain listening on http://localhost:${PORT}`);
  console.log(`  ${stations.length} stations, congestion data ${lookup.quarter}`);
});
