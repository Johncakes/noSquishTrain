/** Usage: npm run route -- 출발역 도착역 */
import { openDb } from './db.ts';
import { buildGraph, findStation } from './graph.ts';
import { findRoute, formatRoute } from './route.ts';

const [origin, dest] = process.argv.slice(2);
if (!origin || !dest) {
  console.error('Usage: npm run route -- <origin> <destination>   e.g. npm run route -- 서울역 잠실');
  process.exit(1);
}

const db = openDb();
const graph = buildGraph(db);

for (const [label, name] of [['origin', origin], ['destination', dest]] as const) {
  const found = findStation(graph, name);
  if (found.length === 0) {
    console.error(`Unknown ${label}: ${name}`);
    process.exit(1);
  }
  console.log(`${label}: ${name} — ${found.map((n) => n.line).join(', ')}`);
}

const route = findRoute(graph, origin, dest);
console.log();
console.log(route ? formatRoute(route) : 'No route found.');

db.close();
