/**
 * Validate the graph against the dataset and against known network facts.
 *
 * The topology corrections in topology.ts are hand-written, so they need
 * checking. The most valuable assertion here is the direction one: every ride
 * edge claims a 상하구분 label, and if that label has no congestion rows for
 * the departing station, the leg could never be scored — which is exactly how
 * a direction mistake would show up.
 */
import { openDb } from './db.ts';
import { buildGraph, edgesFrom, nodeKey, type Graph } from './graph.ts';
import { EXTRA_EDGES, NON_ADJACENT } from './topology.ts';

const db = openDb();
const graph = buildGraph(db);

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const section = (title: string) => console.log(`\n${title}`);

console.log(`graph: ${graph.nodes.size} platforms, ${[...graph.adjacency.values()].reduce((n, e) => n + e.length, 0)} directed edges`);

// --- 1. connectivity ---------------------------------------------------
section('1. connectivity');
{
  const start = graph.nodes.keys().next().value!;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const e of edgesFrom(graph, queue.pop()!)) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  if (seen.size !== graph.nodes.size) {
    const orphans = [...graph.nodes.values()].filter((n) => !seen.has(n.key));
    fail(`${orphans.length} unreachable platforms: ${orphans.slice(0, 8).map((n) => `${n.line} ${n.station}`).join(', ')}`);
  } else {
    console.log(`  OK all ${seen.size} platforms reachable`);
  }
}

// --- 2. ride degree ----------------------------------------------------
section('2. ride degree (1 = terminus, 2 = through, 3+ = junction)');
{
  // Undirected neighbour count. Out-degree alone would misreport every
  // one-way loop station as a terminus.
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let s = neighbours.get(a);
    if (!s) neighbours.set(a, (s = new Set()));
    s.add(b);
  };
  for (const [from, edges] of graph.adjacency) {
    for (const e of edges) {
      if (e.kind !== 'ride') continue;
      link(from, e.to);
      link(e.to, from);
    }
  }

  const termini: string[] = [];
  const junctions: string[] = [];
  for (const n of graph.nodes.values()) {
    const d = neighbours.get(n.key)?.size ?? 0;
    if (d === 0) fail(`isolated platform ${n.line} ${n.station}`);
    else if (d === 1) termini.push(`${n.line} ${n.station}`);
    else if (d > 2) junctions.push(`${n.line} ${n.station} (${d})`);
  }
  console.log(`  termini (${termini.length}): ${termini.join(', ')}`);
  console.log(`  junctions (${junctions.length}): ${junctions.join(', ')}`);
}

// --- 3. direction labels resolve to real data --------------------------
section('3. every ride edge direction exists in the dataset');
{
  const has = db.prepare('SELECT 1 FROM congestion WHERE line=? AND station_no=? AND direction=? LIMIT 1');
  const bad = new Set<string>();
  for (const [from, edges] of graph.adjacency) {
    const node = graph.nodes.get(from)!;
    for (const e of edges) {
      if (e.kind !== 'ride') continue;
      if (!has.get(node.line, node.stationNo, e.direction!)) {
        bad.add(`${node.line} ${node.station}(${node.stationNo}) has no '${e.direction}' rows`);
      }
    }
  }
  if (bad.size) [...bad].slice(0, 12).forEach(fail);
  else console.log('  OK every ride edge direction has congestion rows');
}

// --- 4. corrections refer to real stations -----------------------------
section('4. topology corrections are live');
{
  for (const [line, pairs] of Object.entries(NON_ADJACENT)) {
    for (const [a, b] of pairs) {
      for (const no of [a, b]) {
        if (!graph.nodes.get(nodeKey(line, no))) fail(`NON_ADJACENT ${line} references unknown station ${no}`);
      }
      const still = edgesFrom(graph, nodeKey(line, a)).some((e) => e.to === nodeKey(line, b) && e.kind === 'ride');
      if (still) fail(`NON_ADJACENT ${line} ${a}-${b} was not actually cut`);
    }
  }
  for (const [line, extras] of Object.entries(EXTRA_EDGES)) {
    for (const x of extras) {
      const present = edgesFrom(graph, nodeKey(line, x.a)).some((e) => e.to === nodeKey(line, x.b) && e.kind === 'ride');
      if (!present) fail(`EXTRA_EDGES ${line} ${x.a}->${x.b} missing (${x.note})`);
    }
  }
  if (!failures) console.log('  OK all cuts applied and all extra edges present');
}

// --- 5. known transfers exist ------------------------------------------
section('5. known interchanges');
{
  const expected: [string, string[]][] = [
    ['서울역', ['1호선', '4호선']],
    ['왕십리', ['2호선', '5호선']],
    ['종로3가', ['1호선', '3호선', '5호선']],
    ['동대문역사문화공원', ['2호선', '4호선', '5호선']],
    // Not 신도림: this dataset covers only Seoul Metro's own 1호선 section
    // (서울역~청량리), and 신도림 sits on the Korail-operated stretch.
    ['동대문', ['1호선', '4호선']],
    ['공덕', ['5호선', '6호선']],
    ['충정로', ['2호선', '5호선']],
    ['청구', ['5호선', '6호선']],
  ];
  for (const [name, lines] of expected) {
    const got = new Set((graph.byName.get(name) ?? []).map((n) => n.line));
    const missing = lines.filter((l) => !got.has(l));
    if (missing.length) fail(`${name}: expected ${lines.join('+')}, missing ${missing.join(',')} (have ${[...got].join(',') || 'none'})`);
    else console.log(`  OK ${name}: ${[...got].sort().join(', ')}`);
  }
}

// --- 6. corrected adjacencies match the real network --------------------
section('6. hand-corrected adjacencies');
{
  const rideNeighbours = (line: string, no: number) =>
    new Set(
      edgesFrom(graph, nodeKey(line, no))
        .filter((e) => e.kind === 'ride')
        .map((e) => graph.nodes.get(e.to)!.station),
    );

  const expected: [string, number, string, string[]][] = [
    ['1호선', 155, '동대문', ['종로5가', '동묘앞']],
    ['1호선', 159, '동묘앞', ['신설동']],
    ['8호선', 2821, '복정', ['장지', '남위례']],
    ['8호선', 2828, '남위례', ['산성']],
    ['5호선', 2549, '강동', ['천호', '길동', '둔촌동']],
    ['5호선', 2554, '상일동', ['고덕', '강일']],
    ['2호선', 211, '성수', ['뚝섬', '건대입구', '용답']],
    ['2호선', 245, '신답', ['용답', '용두']],
    ['2호선', 250, '용두', ['신설동']],
    ['6호선', 2611, '응암', ['역촌', '새절']],
  ];

  for (const [line, no, label, want] of expected) {
    const got = rideNeighbours(line, no);
    const missing = want.filter((w) => !got.has(w));
    if (missing.length) fail(`${line} ${label}: missing neighbour(s) ${missing.join(', ')} (have ${[...got].join(', ') || 'none'})`);
    else console.log(`  OK ${line} ${label} -> ${[...got].join(', ')}`);
  }

  // The one-way loop must not have gained a reverse edge.
  if (edgesFrom(graph, nodeKey('6호선', 2612)).some((e) => e.to === nodeKey('6호선', 2611))) {
    fail('6호선 역촌 -> 응암 exists, but 응암순환 is one-way');
  } else {
    console.log('  OK 응암순환 stays one-way');
  }
}

// --- 7. no ride edge departs into an all-zero row -----------------------
section('7. every ride departure has non-zero congestion somewhere');
{
  // If a train runs, some bucket somewhere must be above zero. An identically
  // zero departure means the row describes a service that does not exist —
  // i.e. the congestion is recorded under a different row. This is the check
  // that catches a missing CONGESTION_SOURCE override, and it matters because
  // a phantom 0% actively attracts routes toward it.
  const peak = db.prepare('SELECT MAX(pct) AS m FROM congestion WHERE line=? AND station_no=? AND direction=?');
  const bad = new Set<string>();
  for (const [from, edges] of graph.adjacency) {
    const node = graph.nodes.get(from)!;
    for (const e of edges) {
      if (e.kind !== 'ride') continue;
      const stationNo = e.sourceStationNo ?? node.stationNo;
      const row = peak.get(node.line, stationNo, e.direction!) as { m: number | null } | undefined;
      if (!row || row.m === null || row.m === 0) {
        const to = graph.nodes.get(e.to)!;
        bad.add(`${node.line} ${node.station}(${stationNo}) ${e.direction} -> ${to.station} is always 0%`);
      }
    }
  }
  if (bad.size) [...bad].forEach(fail);
  else console.log('  OK no ride edge reads an all-zero congestion row');
}

db.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
if (failures > 0) process.exitCode = 1;
