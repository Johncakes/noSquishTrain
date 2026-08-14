/**
 * Write the payloads into public/api as static files.
 *
 * Usage: npm run export
 *
 * This is the deploy step. The database is the source of truth but never
 * leaves this machine — it is 16 MB, gitignored, and rebuilt by `npm run
 * ingest` — so the JSON it produces is what gets committed and served. The
 * data changes once a quarter, which is what makes a build artifact in git the
 * right trade rather than a database in production.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPayloads } from '../server/payload.ts';

const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public');

let payloads;
try {
  payloads = buildPayloads();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

mkdirSync(join(PUBLIC_DIR, 'api'), { recursive: true });

let total = 0;
for (const [urlPath, json] of payloads.byPath) {
  // The URL paths are all /api/<name>.json, and public/ is the web root, so
  // the path the page asks for is the path the file sits at.
  const file = join(PUBLIC_DIR, urlPath.replace(/^\//, ''));
  writeFileSync(file, json);
  total += json.length;
  console.log(`  ${urlPath}  ${(json.length / 1024).toFixed(0)} KB`);
}

console.log(
  `wrote ${payloads.byPath.size} files, ${(total / 1024).toFixed(0)} KB total ` +
    `(congestion ${payloads.network.quarter}, coordinates ${payloads.network.coordsVersion})`,
);
