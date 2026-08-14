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

/**
 * Seoul's clock and calendar, wherever the reader happens to be.
 *
 * The map is of Seoul, so the reader's own clock is the wrong one — opening it
 * from London at 09:00 on Friday should show the Seoul evening it actually is
 * there, and from Honolulu on Saturday morning it is already Sunday in Seoul.
 *
 * The weekday goes through a UTC date rather than a formatted day name, so
 * there is no locale string to match against.
 */
export function seoulNow(now: Date = new Date()): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    minutes: part('hour') * 60 + part('minute'),
    weekday: new Date(Date.UTC(part('year'), part('month') - 1, part('day'))).getUTCDay(),
  };
}

/** 0 is Sunday, as `Date.getDay()` has it. */
export function dayTypeOn(weekday: number): DayType {
  if (weekday === 0) return '일요일';
  if (weekday === 6) return '토요일';
  return '평일';
}

/**
 * A clock reading placed on the service day, which runs past midnight: 00:30 is
 * 1470, not 30. `previousDay` marks the small hours that belong to the service
 * day before — 00:15 on a Sunday is Saturday's last train, and reading it as
 * Sunday would report a day that has not started.
 */
function onServiceDay(minutes: number, buckets: readonly number[]): { at: number; previousDay: boolean } {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const outside = (m: number): number => Math.max(0, first - m) + Math.max(0, m - last);
  return outside(minutes) <= outside(minutes + 1440)
    ? { at: minutes, previousDay: false }
    : { at: minutes + 1440, previousDay: true };
}

/**
 * The published bucket covering a clock reading, or null when no train is
 * running — 02:00 has no measurement and never will.
 *
 * The service day runs past midnight — 00:30 is 1470, not 30 — so a reading in
 * the small hours is measured both as itself and as the tail of the day before,
 * and whichever falls nearer the published range wins. Covering means within
 * half a bucket, which is what makes 05:20 the 05:30 reading and 03:00 nothing
 * at all.
 */
export function bucketIndexAt(minutes: number, buckets: readonly number[] = BUCKETS): number | null {
  const { at } = onServiceDay(minutes, buckets);

  let best = 0;
  for (let i = 1; i < buckets.length; i++) {
    if (Math.abs(buckets[i] - at) < Math.abs(buckets[best] - at)) best = i;
  }
  return Math.abs(buckets[best] - at) <= BUCKET_STEP / 2 ? best : null;
}

/** The morning peak, which is the reason to look at this at all. */
export const PEAK_BUCKET = 480;

/**
 * What the page should open on: now in Seoul, or the morning peak when nothing
 * is running.
 *
 * Now is what anyone actually asks of a map like this. But between 00:46 and
 * 05:14 there is no now to show, and an empty map is a worse first impression
 * than a busy one — so the small hours open on 08:00 rather than on nothing.
 *
 * Day type and bucket are decided together, on purpose. They are two controls
 * reading one clock, and the hours where they can disagree are the hours where
 * getting it wrong matters: at 00:15 on a Sunday the map must say 토요일 00:00,
 * a train that is running, rather than 일요일 00:00, one that ran yesterday.
 *
 * In the small hours the fallback looks forward instead: at 03:00 on a Sunday
 * the 08:00 it opens on is Sunday's, still ahead of the reader, not the
 * Saturday morning already behind them.
 */
export function opening(
  now: Date = new Date(),
  buckets: readonly number[] = BUCKETS,
): { dayType: DayType; bucketIndex: number } {
  const { minutes, weekday } = seoulNow(now);
  const bucketIndex = bucketIndexAt(minutes, buckets);

  if (bucketIndex === null) {
    return { dayType: dayTypeOn(weekday), bucketIndex: Math.max(0, buckets.indexOf(PEAK_BUCKET)) };
  }
  const { previousDay } = onServiceDay(minutes, buckets);
  return { dayType: dayTypeOn(previousDay ? (weekday + 6) % 7 : weekday), bucketIndex };
}

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
