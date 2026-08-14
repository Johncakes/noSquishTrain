/**
 * Local server for the congestion map.
 *
 * Usage: npm run serve   (then open http://localhost:8137)
 *
 * It serves the same URLs the deployed site does — public/ as the web root,
 * with the payloads at /api/*.json — the only difference being that here they
 * come from the database in memory instead of from files written by
 * `npm run export`. Developing against the deployed shape is the point: a path
 * that works here works there.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { buildPayloads, type Payloads } from './payload.ts';

const PORT = Number(process.env.PORT ?? 8137);
const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public');

/** A missing database is a setup mistake, not a stack trace. */
function payloadsOrExit(): Payloads {
  try {
    return buildPayloads();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const { network, byPath } = payloadsOrExit();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const send = (status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  try {
    // In-memory payloads win over anything a past export left on disk, so an
    // edit to the data shows up on reload without re-running the export.
    const payload = byPath.get(url.pathname);
    if (payload) return send(200, payload, MIME['.json']);

    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    // normalize() plus the prefix check keeps '..' from escaping the web root.
    const filePath = normalize(join(PUBLIC_DIR, relative));
    if (filePath.startsWith(PUBLIC_DIR) && existsSync(filePath)) {
      return send(200, readFileSync(filePath), MIME[extname(filePath)] ?? 'application/octet-stream');
    }

    return send(404, JSON.stringify({ error: 'Not found' }), MIME['.json']);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return send(500, JSON.stringify({ error: message }), MIME['.json']);
  }
});

server.listen(PORT, () => {
  console.log(`noSquishTrain map on http://localhost:${PORT}`);
  console.log(`  ${network.platforms.length} platforms, ${network.segments.length} segments`);
  console.log(
    network.basemap.length
      ? `  basemap ${network.basemap.length} shapes, ${network.basemap.reduce((n, s) => n + s.points.length, 0)} points`
      : '  no basemap — run `npm run basemap` for water and boundaries',
  );
  console.log(`  congestion ${network.quarter}, coordinates ${network.coordsVersion}`);
  if (!existsSync(join(PUBLIC_DIR, 'dist'))) console.log('  (run `npm run build` first — public/dist is missing)');
});
