/**
 * Fetch the geographic backdrop — water and municipal boundaries — and store
 * it alongside the congestion data.
 *
 * Usage: npm run basemap [-- --dry-run]
 *
 * The extent comes from the stations already loaded, so this must run after
 * `npm run coords`. Nothing else depends on it: the map draws the network with
 * or without a backdrop.
 */
import { openDb, setMeta } from '../data/db.ts';
import { loadCoords } from '../data/coords.ts';
import { fetchBasemap, networkBBox, replaceBasemap } from '../data/basemap.ts';

const dryRun = process.argv.includes('--dry-run');

const db = openDb();
const coords = loadCoords(db);
if (coords.size === 0) {
  console.error('No station coordinates. Run `npm run coords` first.');
  process.exit(1);
}

const box = networkBBox(coords.values());
console.log(
  `extent ${box.minLat.toFixed(3)}..${box.maxLat.toFixed(3)}N ` +
    `${box.minLon.toFixed(3)}..${box.maxLon.toFixed(3)}E (${coords.size} stations)`,
);

const report = await fetchBasemap(box);
console.log(`boundaries clipped to that extent; water kept whole`);

const saved = 1 - report.points / report.pointsBeforeSimplify;
console.log(`water      ${String(report.water).padStart(4)} polygons   (${report.overpassHost})`);
console.log(`districts  ${String(report.districts).padStart(4)} polygons`);
console.log(`points     ${report.points} after simplifying, from ${report.pointsBeforeSimplify} (${(saved * 100).toFixed(0)}% dropped)`);
console.log(`\nmunicipalities kept: ${report.districtNames.join(', ')}`);

if (report.water === 0) {
  console.error('\nNo water at all — the 한강 should be in this box. Refusing to write a backdrop without it.');
  process.exit(1);
}

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  db.close();
  process.exit(0);
}

const written = replaceBasemap(db, report.shapes);
setMeta(db, 'basemap_ingested_at', new Date().toISOString());
setMeta(db, 'basemap_sources', 'OpenStreetMap (water) · KOSTAT 2018 via southkorea-maps (boundaries)');
console.log(`\nwrote ${written} shapes.`);
db.close();
