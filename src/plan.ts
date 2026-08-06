/**
 * Ranked route options for one trip: the same search run under three
 * attitudes to crowding, deduplicated when they agree.
 *
 * Shared by the CLI and the HTTP server so both answer identically.
 */
import type { Lookup } from './congestion.ts';
import type { Graph } from './graph.ts';
import { findRoute } from './route.ts';
import {
  DEFAULT_AVERSION, makeCostFn, routeSignature, scoreRoute, type ScoreContext, type ScoredRoute,
} from './score.ts';

export interface Profile {
  name: string;
  aversion: number;
}

export const PROFILES: Profile[] = [
  { name: 'fastest', aversion: 0 },
  { name: 'balanced', aversion: DEFAULT_AVERSION },
  { name: 'least crowded', aversion: 3 },
];

export interface PlanOption {
  /** Which profiles chose this route. */
  profiles: string[];
  route: ScoredRoute;
  signature: string;
}

export function planTrip(
  graph: Graph,
  lookup: Lookup,
  origin: string,
  dest: string,
  dayType: string,
  startMinutes: number,
): PlanOption[] {
  const found = new Map<string, PlanOption>();

  for (const profile of PROFILES) {
    const ctx: ScoreContext = { graph, lookup, dayType, startMinutes, aversion: profile.aversion };
    const route = findRoute(graph, origin, dest, makeCostFn(ctx));
    if (!route) continue;

    const signature = routeSignature(route);
    const existing = found.get(signature);
    if (existing) {
      existing.profiles.push(profile.name);
      continue;
    }
    found.set(signature, {
      profiles: [profile.name],
      // Always report on the default curve, so options stay comparable even
      // though each was searched under a different weighting.
      route: scoreRoute({ ...ctx, aversion: DEFAULT_AVERSION }, route),
      signature,
    });
  }

  return [...found.values()].sort((a, b) => a.route.perceivedMinutes - b.route.perceivedMinutes);
}
