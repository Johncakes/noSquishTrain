/**
 * Subway graph built from the congestion dataset plus topology.ts.
 *
 * A node is a platform: one station on one line. Riding moves between nodes
 * on the same line; transferring moves between nodes that share a base
 * station name. Keeping transfers as real edges (rather than collapsing a
 * station into a single node) is what lets a route be scored per leg and lets
 * a transfer carry its own time penalty.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  CONGESTION_SOURCE,
  DEFAULT_DIRECTIONS,
  EXCLUDED_STATION_NOS,
  EXTRA_EDGES,
  FORWARD_OVERRIDE,
  NON_ADJACENT,
  ONE_WAY,
  RIDE_MINUTES,
  TRANSFER_MINUTES,
  baseName,
  directionsFor,
} from './topology.ts';

export interface Node {
  key: string;
  line: string;
  stationNo: number;
  station: string;
  /** Name with any disambiguating suffix stripped, used for transfers. */
  name: string;
}

export interface Edge {
  from: string;
  to: string;
  kind: 'ride' | 'transfer';
  minutes: number;
  /** For rides: the 상하구분 value to look congestion up under. */
  direction?: string;
  /**
   * 역번호 whose congestion row describes this departure. Differs from the
   * node's own number where a platform serves two services (see
   * CONGESTION_SOURCE).
   */
  sourceStationNo?: number;
}

export interface Graph {
  nodes: Map<string, Node>;
  adjacency: Map<string, Edge[]>;
  /** Base station name -> every platform serving it. */
  byName: Map<string, Node[]>;
}

export const nodeKey = (line: string, stationNo: number) => `${line}:${stationNo}`;

function addEdge(g: Graph, edge: Edge): void {
  let list = g.adjacency.get(edge.from);
  if (!list) g.adjacency.set(edge.from, (list = []));
  list.push(edge);
}

/**
 * Add a ride edge a -> b, and the reverse unless the section is one-way.
 * Each orientation carries its own 상하구분 label.
 */
function addRide(g: Graph, a: Node, b: Node, forward: string, backward: string, oneWay: boolean): void {
  addEdge(g, { from: a.key, to: b.key, kind: 'ride', minutes: RIDE_MINUTES, direction: forward });
  if (oneWay) return;
  addEdge(g, { from: b.key, to: a.key, kind: 'ride', minutes: RIDE_MINUTES, direction: backward });
}

export function buildGraph(db: DatabaseSync): Graph {
  const graph: Graph = { nodes: new Map(), adjacency: new Map(), byName: new Map() };

  const rows = db
    .prepare('SELECT DISTINCT line, station_no, station FROM congestion ORDER BY line, station_no')
    .all() as { line: string; station_no: number; station: string }[];

  // --- nodes -------------------------------------------------------------
  const byLine = new Map<string, Node[]>();
  for (const row of rows) {
    if (EXCLUDED_STATION_NOS[row.line]?.includes(row.station_no)) continue;

    const key = nodeKey(row.line, row.station_no);
    // 5호선 2549 appears twice ('강동', '강동(하남검단산)'); the first name wins,
    // and baseName() collapses both to the same transfer identity anyway.
    if (graph.nodes.has(key)) continue;

    const node: Node = {
      key,
      line: row.line,
      stationNo: row.station_no,
      station: row.station,
      name: baseName(row.station),
    };
    graph.nodes.set(key, node);

    let lineNodes = byLine.get(row.line);
    if (!lineNodes) byLine.set(row.line, (lineNodes = []));
    lineNodes.push(node);

    let named = graph.byName.get(node.name);
    if (!named) graph.byName.set(node.name, (named = []));
    named.push(node);
  }

  // --- ride edges from consecutive numbering ------------------------------
  for (const [line, nodes] of byLine) {
    const { forward, backward } = directionsFor(line);
    const cuts = new Set((NON_ADJACENT[line] ?? []).map(([a, b]) => `${a}-${b}`));
    const oneWays = new Set((ONE_WAY[line] ?? []).map(([a, b]) => `${a}-${b}`));
    const overrides = new Map((FORWARD_OVERRIDE[line] ?? []).map((o) => [`${o.a}-${o.b}`, o.forward]));

    nodes.sort((x, y) => x.stationNo - y.stationNo);
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const cur = nodes[i];
      if (cur.stationNo - prev.stationNo !== 1) continue;
      const pair = `${prev.stationNo}-${cur.stationNo}`;
      if (cuts.has(pair)) continue;
      const fwd = overrides.get(pair) ?? forward;
      const bwd = fwd === forward ? backward : forward;
      addRide(graph, prev, cur, fwd, bwd, oneWays.has(pair));
    }
  }

  // --- ride edges the numbering does not express -------------------------
  for (const [line, extras] of Object.entries(EXTRA_EDGES)) {
    const { forward, backward } = directionsFor(line);
    for (const extra of extras) {
      const a = graph.nodes.get(nodeKey(line, extra.a));
      const b = graph.nodes.get(nodeKey(line, extra.b));
      if (!a || !b) throw new Error(`EXTRA_EDGES ${line} ${extra.a}->${extra.b}: unknown station (${extra.note})`);
      // An extra edge may run against numeric order (e.g. 용두 250 -> 신설동
      // 246), so its forward label is taken from the declaration, not from
      // comparing numbers.
      const fwd = extra.forward ?? forward;
      const bwd = fwd === forward ? backward : forward;
      addRide(graph, a, b, fwd, bwd, extra.oneWay === true);
    }
  }

  // --- congestion row overrides ------------------------------------------
  for (const [line, sources] of Object.entries(CONGESTION_SOURCE)) {
    for (const src of sources) {
      const from = nodeKey(line, src.from);
      const to = nodeKey(line, src.to);
      const edge = edgesFrom(graph, from).find((e) => e.to === to && e.kind === 'ride');
      if (!edge) throw new Error(`CONGESTION_SOURCE ${line} ${src.from}->${src.to}: no such ride edge (${src.note})`);
      edge.sourceStationNo = src.stationNo;
    }
  }

  // --- transfer edges ----------------------------------------------------
  for (const platforms of graph.byName.values()) {
    if (platforms.length < 2) continue;
    for (const a of platforms) {
      for (const b of platforms) {
        if (a.key === b.key || a.line === b.line) continue;
        addEdge(graph, { from: a.key, to: b.key, kind: 'transfer', minutes: TRANSFER_MINUTES });
      }
    }
  }

  return graph;
}

export function edgesFrom(graph: Graph, key: string): Edge[] {
  return graph.adjacency.get(key) ?? [];
}

/** Every platform serving a station, by exact or base name. */
export function findStation(graph: Graph, query: string): Node[] {
  const exact = graph.byName.get(baseName(query.trim()));
  if (exact) return exact;
  const needle = query.trim();
  return [...graph.nodes.values()].filter((n) => n.station.includes(needle) || n.name.includes(needle));
}

export { DEFAULT_DIRECTIONS, TRANSFER_MINUTES, RIDE_MINUTES };
