/**
 * Turning congestion into something comparable with time.
 *
 * Rather than a blend factor bolted onto two incompatible units, a minute
 * spent in a crowded car is priced as costing *more than a minute*. The
 * search then optimises a single quantity — perceived minutes — and the
 * output stays explainable ("22 min, but it feels like 34").
 *
 * The anchor points come from how the operator defines the measure: 34% is
 * every seat taken, 100% is the nominal full load, and the dataset tops out
 * near 148%.
 */
import type { Lookup } from './congestion.ts';
import type { Graph, Node } from './graph.ts';
import type { CostFn, Leg, Route } from './route.ts';
import { RIDE_MINUTES } from './topology.ts';

/** How hard to avoid crowding. 0 ignores it; 1 is the default curve. */
export const DEFAULT_AVERSION = 1;

/**
 * Discomfort multiplier for one minute of riding at `pct` congestion.
 *
 *   <= 34%  seat available          -> 1.00
 *     100%  nominal full load       -> 1.80
 *     148%  worst observed          -> 3.00
 *
 * Piecewise linear between those anchors. `aversion` scales the part above
 * 1.0, so aversion 0 recovers a pure-time search exactly.
 */
export function discomfort(pct: number | null, aversion: number = DEFAULT_AVERSION): number {
  if (pct === null) return 1; // unknown: charge it as ordinary time
  let base: number;
  if (pct <= 34) base = 1;
  else if (pct <= 100) base = 1 + (pct - 34) * (0.8 / 66);
  else base = 1.8 + (pct - 100) * (1.2 / 48);
  return 1 + (base - 1) * aversion;
}

export interface ScoreContext {
  graph: Graph;
  lookup: Lookup;
  dayType: string;
  /** Departure time in minutes from midnight. */
  startMinutes: number;
  aversion: number;
}

/**
 * Congestion at the moment a train departs in `direction`.
 *
 * `stationNo` is the row to read, which is not always the node's own number —
 * a platform serving two services records the second one elsewhere.
 */
function pctAt(
  ctx: ScoreContext,
  line: string,
  stationNo: number,
  direction: string | undefined,
  elapsed: number,
): number | null {
  if (!direction) return null;
  return ctx.lookup.at(line, stationNo, direction, ctx.dayType, ctx.startMinutes + elapsed);
}

/**
 * Cost function for the route search.
 *
 * A ride is charged its duration times the discomfort of the car you board
 * at the departing station. Transfers are charged flat — walking a corridor
 * is unpleasant but the dataset says nothing about how crowded it is, and
 * inventing a number there would quietly bias every route with an interchange.
 */
export function makeCostFn(ctx: ScoreContext): CostFn {
  return (edge, from, elapsed) => {
    if (edge.kind !== 'ride') return edge.minutes;
    const pct = pctAt(ctx, from.line, edge.sourceStationNo ?? from.stationNo, edge.direction, elapsed);
    return edge.minutes * discomfort(pct, ctx.aversion);
  };
}

export interface ScoredLeg extends Leg {
  /** Congestion at each departure along the leg; null where unknown. */
  pcts: (number | null)[];
  peakPct: number | null;
  meanPct: number | null;
  perceivedMinutes: number;
}

export interface ScoredRoute extends Route {
  legs: ScoredLeg[];
  perceivedMinutes: number;
  peakPct: number | null;
  /** Ride minutes with no congestion row behind them. */
  unknownMinutes: number;
}

/** Attach per-leg congestion to an already-found route. */
export function scoreRoute(ctx: ScoreContext, route: Route): ScoredRoute {
  const legs: ScoredLeg[] = route.legs.map((leg) => {
    if (leg.kind !== 'ride') {
      return { ...leg, pcts: [], peakPct: null, meanPct: null, perceivedMinutes: leg.minutes };
    }

    const pcts: (number | null)[] = [];
    let perceived = 0;
    // One reading per departure, so the final station is not counted — you
    // do not board a train there.
    for (let i = 0; i < leg.keys.length - 1; i++) {
      const node = ctx.graph.nodes.get(leg.keys[i])!;
      const pct = pctAt(ctx, node.line, leg.sourceNos[i], leg.direction, leg.offset + i * RIDE_MINUTES);
      pcts.push(pct);
      perceived += RIDE_MINUTES * discomfort(pct, ctx.aversion);
    }

    const known = pcts.filter((p): p is number => p !== null);
    return {
      ...leg,
      pcts,
      peakPct: known.length ? Math.max(...known) : null,
      meanPct: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
      perceivedMinutes: perceived,
    };
  });

  const allPcts = legs.flatMap((l) => l.pcts).filter((p): p is number => p !== null);
  const unknownMinutes = legs
    .filter((l) => l.kind === 'ride')
    .reduce((n, l) => n + l.pcts.filter((p) => p === null).length * RIDE_MINUTES, 0);

  return {
    ...route,
    legs,
    perceivedMinutes: legs.reduce((n, l) => n + l.perceivedMinutes, 0),
    peakPct: allPcts.length ? Math.max(...allPcts) : null,
    unknownMinutes,
  };
}

/** Stable identity for deduplicating routes that differ only in search weight. */
export function routeSignature(route: Route): string {
  return route.legs.map((l) => `${l.kind}:${l.line}:${l.from}>${l.to}`).join('|');
}

/** A crude crowding badge for terminal output. */
export function badge(pct: number | null): string {
  if (pct === null) return '  ?  ';
  if (pct <= 34) return 'seat ';
  if (pct <= 70) return 'ok   ';
  if (pct <= 100) return 'busy ';
  if (pct <= 130) return 'PACKED';
  return 'CRUSH';
}
