/**
 * "What if I left at a different time?"
 *
 * The dataset is a time-of-day profile, so its most actionable question is
 * not which route to take but when to leave. This re-plans the same trip at
 * every published 30-minute bucket and reports how the answer moves.
 *
 * The best route can change between buckets, so each entry keeps its own
 * route rather than assuming one path holds all day.
 */
import { BUCKET_STEP, FIRST_BUCKET, LAST_BUCKET, type Lookup } from './congestion.ts';
import type { Graph } from './graph.ts';
import { findRoute } from './route.ts';
import {
  DEFAULT_AVERSION, makeCostFn, routeSignature, scoreRoute, type ScoreContext, type ScoredRoute,
} from './score.ts';

export interface SweepEntry {
  departMinutes: number;
  route: ScoredRoute;
  signature: string;
}

export interface SweepOptions {
  from?: number;
  to?: number;
  aversion?: number;
}

export function sweep(
  graph: Graph,
  lookup: Lookup,
  origin: string,
  dest: string,
  dayType: string,
  options: SweepOptions = {},
): SweepEntry[] {
  const start = Math.max(FIRST_BUCKET, options.from ?? FIRST_BUCKET);
  const end = Math.min(LAST_BUCKET, options.to ?? LAST_BUCKET);
  const aversion = options.aversion ?? DEFAULT_AVERSION;

  const entries: SweepEntry[] = [];
  for (let depart = start; depart <= end; depart += BUCKET_STEP) {
    const ctx: ScoreContext = { graph, lookup, dayType, startMinutes: depart, aversion };
    const found = findRoute(graph, origin, dest, makeCostFn(ctx));
    if (!found) continue;
    entries.push({
      departMinutes: depart,
      // Report on the default curve so entries stay comparable.
      route: scoreRoute({ ...ctx, aversion: DEFAULT_AVERSION }, found),
      signature: routeSignature(found),
    });
  }
  return entries;
}

export interface SweepSummary {
  best: SweepEntry;
  worst: SweepEntry;
  /** Minutes of perceived time saved by departing at `best` instead of `worst`. */
  spread: number;
  distinctRoutes: number;
}

export function summarize(entries: SweepEntry[]): SweepSummary | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.route.perceivedMinutes - b.route.perceivedMinutes);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  return {
    best,
    worst,
    spread: worst.route.perceivedMinutes - best.route.perceivedMinutes,
    distinctRoutes: new Set(entries.map((e) => e.signature)).size,
  };
}

export interface FlexibilityAdvice {
  now: SweepEntry;
  best: SweepEntry;
  waitMinutes: number;
  perceivedSaved: number;
  /**
   * True when the perceived saving exceeds the wait itself — i.e. worth
   * standing on the platform for. False still leaves the advice useful for
   * planning tomorrow, where the wait costs nothing.
   */
  worthWaiting: boolean;
}

/**
 * Best departure within `windowMinutes` of `target`.
 *
 * Two different questions hide here: "should I wait right now" (the wait is a
 * real cost) and "when should I plan to leave" (it is free). Reporting both
 * saving and wait lets the caller answer either without a fudge factor.
 */
export function flexibilityAdvice(
  entries: SweepEntry[],
  target: number,
  windowMinutes = 120,
): FlexibilityAdvice | null {
  const now = entries.find((e) => e.departMinutes >= target);
  if (!now) return null;

  const window = entries.filter(
    (e) => e.departMinutes >= now.departMinutes && e.departMinutes <= now.departMinutes + windowMinutes,
  );
  const best = window.reduce((a, b) => (b.route.perceivedMinutes < a.route.perceivedMinutes ? b : a), now);
  if (best === now) return null;

  const waitMinutes = best.departMinutes - now.departMinutes;
  const perceivedSaved = now.route.perceivedMinutes - best.route.perceivedMinutes;
  return { now, best, waitMinutes, perceivedSaved, worthWaiting: perceivedSaved > waitMinutes };
}
