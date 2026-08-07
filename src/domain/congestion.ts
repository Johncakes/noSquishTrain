/**
 * Congestion lookup: (line, station, direction, day type, time) -> percent.
 *
 * The whole table is ~65k rows, so it is loaded into a Map once rather than
 * queried per edge — a route search touches thousands of edges and each one
 * needs a lookup.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SERVICES, type Service } from '../data/normalize.ts';

/** Service day runs 05:30 (330) to 00:30 next day (1470), in 30-min steps. */
export const FIRST_BUCKET = 330;
export const LAST_BUCKET = 1470;
export const BUCKET_STEP = 30;

export const DAY_TYPES = ['평일', '토요일', '일요일'] as const;
export type DayType = (typeof DAY_TYPES)[number];

export interface Lookup {
  /** Congestion percent, or null when the dataset has no row for it. */
  at(
    line: string,
    stationNo: number,
    direction: string,
    dayType: string,
    minutes: number,
    service?: Service,
  ): number | null;
  /** Which services this platform/direction actually publishes. */
  servicesAt(line: string, stationNo: number, direction: string): Service[];
  quarter: string | null;
}

const key = (
  dayType: string, line: string, stationNo: number,
  direction: string, service: string, bucket: number,
) => `${dayType}|${line}|${stationNo}|${direction}|${service}|${bucket}`;

/**
 * Snap a time to the nearest published bucket.
 *
 * Times outside service hours clamp to the nearest end rather than failing —
 * a 03:00 query is answered with first-train data and flagged by the caller,
 * which is more useful than refusing.
 */
export function nearestBucket(minutes: number): number {
  const clamped = Math.min(LAST_BUCKET, Math.max(FIRST_BUCKET, minutes));
  const steps = Math.round((clamped - FIRST_BUCKET) / BUCKET_STEP);
  return FIRST_BUCKET + steps * BUCKET_STEP;
}

export function isOutsideService(minutes: number): boolean {
  return minutes < FIRST_BUCKET || minutes > LAST_BUCKET;
}

/** Parse 'HH:MM' into minutes. Accepts 24:xx and treats 00:xx as after midnight. */
export function parseTime(text: string): number {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`Bad time '${text}', expected HH:MM`);
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 24 || minute > 59) throw new Error(`Bad time '${text}'`);
  if (hour < 4) hour += 24; // 00:30 means the end of the service day
  return hour * 60 + minute;
}

export function formatTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function normalizeDayType(input: string): DayType {
  const found = DAY_TYPES.find((d) => d === input.trim());
  if (found) return found;
  const aliases: Record<string, DayType> = {
    weekday: '평일', wed: '평일', mon: '평일', 평일: '평일',
    sat: '토요일', saturday: '토요일',
    sun: '일요일', sunday: '일요일',
  };
  const hit = aliases[input.trim().toLowerCase()];
  if (!hit) throw new Error(`Unknown day type '${input}'. Use one of ${DAY_TYPES.join(', ')}.`);
  return hit;
}

export function loadCongestion(db: DatabaseSync): Lookup {
  const table = new Map<string, number>();
  const services = new Map<string, Set<Service>>();

  const rows = db
    .prepare('SELECT day_type, line, station_no, direction, service, bucket_min, pct FROM congestion')
    .all() as {
    day_type: string; line: string; station_no: number; direction: string;
    service: string; bucket_min: number; pct: number;
  }[];

  for (const r of rows) {
    table.set(key(r.day_type, r.line, r.station_no, r.direction, r.service, r.bucket_min), r.pct);
    const platformKey = `${r.line}|${r.station_no}|${r.direction}`;
    let set = services.get(platformKey);
    if (!set) services.set(platformKey, (set = new Set()));
    set.add(r.service as Service);
  }

  const meta = db.prepare("SELECT value FROM meta WHERE key = 'quarter'").get() as { value: string } | undefined;

  return {
    quarter: meta?.value ?? null,
    at(line, stationNo, direction, dayType, minutes, service = '일반') {
      const found = table.get(key(dayType, line, stationNo, direction, service, nearestBucket(minutes)));
      return found ?? null;
    },
    servicesAt(line, stationNo, direction) {
      const set = services.get(`${line}|${stationNo}|${direction}`);
      // Ordered by SERVICES so callers get 일반 before 급행, never insertion order.
      return set ? SERVICES.filter((s) => set.has(s)) : [];
    },
  };
}
