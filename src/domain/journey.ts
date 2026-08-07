/**
 * What crowding you actually meet, boarding by boarding.
 *
 * A journey is a sequence of legs you already know — from ODsay, not from any
 * pathfinding here. The point is that each leg is read at the time you *reach*
 * it: a transfer 25 minutes in lands in a different 30-minute bucket than your
 * departure, and that is exactly the case a departure-time-only view misses.
 *
 * Ranking minimises the WORST leg, not the average. One crushed train ruins
 * the trip; a calm second leg does not compensate for it.
 */
import { BUCKET_STEP, FIRST_BUCKET, LAST_BUCKET, type Lookup } from './congestion.ts';

export interface JourneyLeg {
  line: string;
  boardStation: string;
  alightStation: string;
  /** 상하구분 for this boarding, or null when the line has no congestion data. */
  direction: string | null;
  /** 역번호 whose row describes this boarding; null when uncovered. */
  congestionStationNo: number | null;
  /** Riding time for this leg, from ODsay. */
  rideMinutes: number;
  /** Minutes from journey start at which you board — includes transfer walking. */
  offsetMinutes: number;
  /** False for lines outside 서울교통공사 1-8, which have no published congestion. */
  covered: boolean;
  stops?: number;
}

export interface BoardingReading {
  leg: JourneyLeg;
  /** Congestion at the moment you board, or null when uncovered/missing. */
  pct: number | null;
  /** Clock time of this boarding, minutes from midnight. */
  atMinutes: number;
}

export interface JourneyEvaluation {
  departMinutes: number;
  readings: BoardingReading[];
  /** Worst covered boarding. Null when nothing on the journey is covered. */
  worstPct: number | null;
  meanPct: number | null;
  coveredLegs: number;
  uncoveredLegs: number;
  totalMinutes: number;
}

/** Congestion met at every boarding, for one departure time. */
export function evaluate(
  legs: JourneyLeg[],
  lookup: Lookup,
  dayType: string,
  departMinutes: number,
): JourneyEvaluation {
  const readings: BoardingReading[] = legs.map((leg) => {
    const atMinutes = departMinutes + leg.offsetMinutes;
    const pct =
      leg.covered && leg.direction !== null && leg.congestionStationNo !== null
        ? lookup.at(leg.line, leg.congestionStationNo, leg.direction, dayType, atMinutes)
        : null;
    return { leg, pct, atMinutes };
  });

  const known = readings.map((r) => r.pct).filter((p): p is number => p !== null);
  const last = legs[legs.length - 1];

  return {
    departMinutes,
    readings,
    worstPct: known.length ? Math.max(...known) : null,
    meanPct: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
    coveredLegs: readings.filter((r) => r.pct !== null).length,
    uncoveredLegs: readings.filter((r) => r.pct === null).length,
    totalMinutes: last ? last.offsetMinutes + last.rideMinutes : 0,
  };
}

/** The same journey evaluated at every published departure bucket. */
export function sweepJourney(legs: JourneyLeg[], lookup: Lookup, dayType: string): JourneyEvaluation[] {
  const out: JourneyEvaluation[] = [];
  for (let depart = FIRST_BUCKET; depart <= LAST_BUCKET; depart += BUCKET_STEP) {
    out.push(evaluate(legs, lookup, dayType, depart));
  }
  return out;
}

/**
 * Order two evaluations. Fewer squished boardings first, then worst leg, then
 * average. An evaluation with no covered legs at all sorts last — it is not
 * "perfectly calm", it is unknown.
 */
function compare(a: JourneyEvaluation, b: JourneyEvaluation): number {
  if (a.worstPct === null && b.worstPct === null) return a.departMinutes - b.departMinutes;
  if (a.worstPct === null) return 1;
  if (b.worstPct === null) return -1;
  if (a.worstPct !== b.worstPct) return a.worstPct - b.worstPct;
  return (a.meanPct ?? 0) - (b.meanPct ?? 0);
}

export interface Recommendation {
  best: JourneyEvaluation;
  worst: JourneyEvaluation;
  /** Percentage points between the best and worst departure's worst leg. */
  spread: number;
  /** Best departure within `windowMinutes` after `target`, if better than `target` itself. */
  betterNearby: { evaluation: JourneyEvaluation; waitMinutes: number; pointsSaved: number } | null;
}

export function recommend(
  evaluations: JourneyEvaluation[],
  target?: number,
  windowMinutes = 120,
): Recommendation | null {
  const scored = evaluations.filter((e) => e.worstPct !== null);
  if (scored.length === 0) return null;

  const sorted = [...scored].sort(compare);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  let betterNearby: Recommendation['betterNearby'] = null;
  if (target !== undefined) {
    const now = scored.find((e) => e.departMinutes >= target);
    if (now) {
      const window = scored.filter(
        (e) => e.departMinutes >= now.departMinutes && e.departMinutes <= now.departMinutes + windowMinutes,
      );
      const pick = [...window].sort(compare)[0];
      if (pick && pick !== now && pick.worstPct! < now.worstPct!) {
        betterNearby = {
          evaluation: pick,
          waitMinutes: pick.departMinutes - now.departMinutes,
          pointsSaved: now.worstPct! - pick.worstPct!,
        };
      }
    }
  }

  return { best, worst, spread: worst.worstPct! - best.worstPct!, betterNearby };
}
