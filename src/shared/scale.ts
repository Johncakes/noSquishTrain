/**
 * The congestion scale. Shared by the server, the CLI and the browser, so a
 * threshold can never mean one thing in the map and another in a table.
 *
 * No Node or DOM imports — this file is compiled for both.
 *
 * The bands are the operator's own semantics rather than even slices of the
 * range: 34% is where every seat is taken, 100% is the design capacity, and
 * anything past 130% is the crush people actually complain about. Even slices
 * would put a boundary in the middle of "standing comfortably" and none at
 * capacity, which is the one number the whole dataset is defined against.
 */

export interface Band {
  /** Lower bound, inclusive. The first band starts at 0. */
  from: number;
  label: string;
  /** What it means to stand in it. */
  detail: string;
}

export const BANDS: readonly Band[] = [
  { from: 0, label: '여유', detail: 'seat likely' },
  { from: 34, label: '보통', detail: 'standing, room to move' },
  { from: 70, label: '혼잡', detail: 'standing, shoulder to shoulder' },
  { from: 100, label: '매우 혼잡', detail: 'over capacity, pressed together' },
  { from: 130, label: '극심', detail: 'crush' },
] as const;

/** Highest value the dataset reaches, for the legend's top end. */
export const SCALE_MAX = 150;

/** Which band a reading falls in. Returns -1 for no data — never band 0. */
export function bandIndex(pct: number | null): number {
  if (pct === null || Number.isNaN(pct)) return -1;
  for (let i = BANDS.length - 1; i >= 0; i--) {
    if (pct >= BANDS[i].from) return i;
  }
  return 0;
}

export function bandLabel(pct: number | null): string {
  const i = bandIndex(pct);
  return i < 0 ? 'no data' : BANDS[i].label;
}

/** CSS custom property holding this band's colour, defined once per theme. */
export function bandColorVar(pct: number | null): string {
  const i = bandIndex(pct);
  return i < 0 ? 'var(--no-data)' : `var(--band-${i})`;
}

/** Service day: 05:30 (330) to 00:30 next day (1470), in 30-minute steps. */
export const FIRST_BUCKET = 330;
export const LAST_BUCKET = 1470;
export const BUCKET_STEP = 30;

export const BUCKETS: readonly number[] = Array.from(
  { length: (LAST_BUCKET - FIRST_BUCKET) / BUCKET_STEP + 1 },
  (_, i) => FIRST_BUCKET + i * BUCKET_STEP,
);

/** Minutes-from-midnight to 'HH:MM'. Values past 1440 wrap to the small hours. */
export function formatClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export const DAY_TYPES = ['평일', '토요일', '일요일'] as const;
export type DayType = (typeof DAY_TYPES)[number];

/**
 * Filename-safe names for the day types, because each one ships as its own
 * static JSON file. ASCII rather than the Korean labels: the label is what the
 * page shows, the slug is what a URL and a filesystem have to agree on.
 */
export const DAY_SLUGS: Record<DayType, string> = {
  평일: 'weekday',
  토요일: 'saturday',
  일요일: 'sunday',
};
