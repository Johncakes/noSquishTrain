/**
 * Shortest-path search over the subway graph.
 *
 * The cost function is pluggable so the same search can rank by time now and
 * by a time+congestion blend once scoring lands — congestion is a property of
 * (line, station, direction, time), which is exactly what an edge carries.
 */
import { edgesFrom, findStation, type Edge, type Graph, type Node } from './graph.ts';

export interface Leg {
  line: string;
  direction?: string;
  from: string;
  to: string;
  /** Station names traversed, inclusive of both ends. */
  stations: string[];
  stops: number;
  minutes: number;
  kind: 'ride' | 'transfer';
}

export interface Route {
  legs: Leg[];
  totalMinutes: number;
  transfers: number;
  cost: number;
}

/** Cost of traversing `edge`, departing from `from`. Defaults to minutes. */
export type CostFn = (edge: Edge, from: Node) => number;

const byTime: CostFn = (edge) => edge.minutes;

interface Visit {
  cost: number;
  minutes: number;
  via?: { edge: Edge; from: string };
}

export function findRoute(graph: Graph, originName: string, destName: string, cost: CostFn = byTime): Route | null {
  const origins = findStation(graph, originName);
  const targets = new Set(findStation(graph, destName).map((n) => n.key));
  if (origins.length === 0) throw new Error(`Unknown origin station: ${originName}`);
  if (targets.size === 0) throw new Error(`Unknown destination station: ${destName}`);

  const best = new Map<string, Visit>();
  // Every platform of the origin starts free, so boarding the right line is
  // not charged as a transfer.
  for (const o of origins) best.set(o.key, { cost: 0, minutes: 0 });

  const settled = new Set<string>();
  let goal: string | null = null;

  // 277 nodes — a linear scan for the frontier minimum is well below the
  // point where a heap would pay for itself.
  for (;;) {
    let current: string | null = null;
    let currentCost = Infinity;
    for (const [key, v] of best) {
      if (!settled.has(key) && v.cost < currentCost) {
        current = key;
        currentCost = v.cost;
      }
    }
    if (current === null) break;
    if (targets.has(current)) {
      goal = current;
      break;
    }

    settled.add(current);
    const from = graph.nodes.get(current)!;
    const here = best.get(current)!;

    for (const edge of edgesFrom(graph, current)) {
      if (settled.has(edge.to)) continue;
      const next = here.cost + cost(edge, from);
      const known = best.get(edge.to);
      if (!known || next < known.cost) {
        best.set(edge.to, { cost: next, minutes: here.minutes + edge.minutes, via: { edge, from: current } });
      }
    }
  }

  if (goal === null) return null;

  // Walk the predecessor chain back to an origin.
  const chain: { edge: Edge; from: string }[] = [];
  for (let key = goal; ; ) {
    const via = best.get(key)!.via;
    if (!via) break;
    chain.push(via);
    key = via.from;
  }
  chain.reverse();

  return toRoute(graph, goal, chain, best.get(goal)!.cost);
}

/** Collapse the edge chain into per-line legs. */
function toRoute(graph: Graph, goal: string, chain: { edge: Edge; from: string }[], cost: number): Route {
  const legs: Leg[] = [];

  for (const { edge, from } of chain) {
    const fromNode = graph.nodes.get(from)!;
    const toNode = graph.nodes.get(edge.to)!;

    if (edge.kind === 'transfer') {
      legs.push({
        kind: 'transfer',
        line: `${fromNode.line} → ${toNode.line}`,
        from: fromNode.name,
        to: toNode.name,
        stations: [fromNode.name],
        stops: 0,
        minutes: edge.minutes,
      });
      continue;
    }

    const last = legs[legs.length - 1];
    if (last?.kind === 'ride' && last.line === fromNode.line && last.direction === edge.direction) {
      last.to = toNode.station;
      last.stations.push(toNode.station);
      last.stops++;
      last.minutes += edge.minutes;
    } else {
      legs.push({
        kind: 'ride',
        line: fromNode.line,
        direction: edge.direction,
        from: fromNode.station,
        to: toNode.station,
        stations: [fromNode.station, toNode.station],
        stops: 1,
        minutes: edge.minutes,
      });
    }
  }

  return {
    legs,
    totalMinutes: legs.reduce((n, l) => n + l.minutes, 0),
    transfers: legs.filter((l) => l.kind === 'transfer').length,
    cost,
  };
}

export function formatRoute(route: Route): string {
  const lines = route.legs.map((leg) =>
    leg.kind === 'transfer'
      ? `  ~ transfer ${leg.line} at ${leg.from}  (${leg.minutes}min)`
      : `  ${leg.line} ${leg.direction}  ${leg.from} → ${leg.to}  ${leg.stops} stops, ${leg.minutes}min`,
  );
  lines.push(`  total ${route.totalMinutes}min, ${route.transfers} transfer(s)`);
  return lines.join('\n');
}
