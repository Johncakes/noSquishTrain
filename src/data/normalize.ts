/**
 * Shared normalization between the CSV seeder and the open-API ingest.
 *
 * Both sources carry the same 서울교통공사 congestion shape: one row per
 * (day type, line, station, direction) with 38 wide time-bucket columns.
 * Everything here turns that wide row into long-format records.
 */

export const FIXED_COLUMNS = {
  dayType: '요일구분',
  line: '호선',
  stationNo: '역번호',
  station: '출발역',
  direction: '상하구분',
} as const;

/**
 * Which train. Lines 1-8 run one service, so everything from that source is
 * 일반. 9호선 publishes 급행 separately, and at a station where both stop they
 * are different trains with very different loads — 급행 reaches 186% where the
 * 일반 beside it is under 70%. Averaging or overwriting them would erase the
 * single most crowded thing in the network.
 */
export const SERVICES = ['일반', '급행'] as const;
export type Service = (typeof SERVICES)[number];

export interface CongestionRow {
  dayType: string;
  line: string;
  stationNo: number;
  station: string;
  direction: string;
  service: Service;
  /** Canonical 'HH:MM'. Post-midnight buckets become 24:00 / 24:30 so lexical order stays chronological. */
  bucket: string;
  /** Minutes from midnight of the service day; 330 (05:30) .. 1470 (00:30 next day). */
  bucketMin: number;
  pct: number;
}

/**
 * Parse a header like '5시30분' into minutes from midnight.
 *
 * The service day runs 05:30 -> 00:30, so hours 0-3 belong to the *following*
 * calendar day and are pushed past 1440. Without this, 00시30분 would sort
 * before the 05:30 opening bucket and the "nearest time bucket" join would
 * silently pick the wrong end of the day.
 */
export function parseBucketLabel(label: string): { bucket: string; bucketMin: number } | null {
  const m = label.match(/^(\d{1,2})시(\d{1,2})분$/);
  if (!m) return null;

  const rawHour = Number(m[1]);
  const minute = Number(m[2]);
  const hour = rawHour < 4 ? rawHour + 24 : rawHour;

  return {
    bucket: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    bucketMin: hour * 60 + minute,
  };
}

/** Every bucket column present in a record, in chronological order. */
export function bucketColumns(keys: readonly string[]) {
  return keys
    .map((key) => ({ key, ...parseBucketLabel(key) }))
    .filter((c): c is { key: string; bucket: string; bucketMin: number } => c.bucket !== undefined)
    .sort((a, b) => a.bucketMin - b.bucketMin);
}

/**
 * Values arrive as '8.0 ' (CSV, trailing space) or 8.0 / '8.0' (JSON).
 * Blank or unparseable cells return null and are dropped rather than stored
 * as 0 — a missing measurement is not an empty train.
 */
function toPct(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function field(record: Record<string, unknown>, name: string): string {
  const v = record[name];
  if (v === null || v === undefined) throw new Error(`Missing column '${name}' in record`);
  return String(v).trim();
}

/** Expand one wide source record into one long-format row per time bucket. */
export function expandRecord(record: Record<string, unknown>): CongestionRow[] {
  const dayType = field(record, FIXED_COLUMNS.dayType);
  const line = field(record, FIXED_COLUMNS.line);
  const stationNo = Number(field(record, FIXED_COLUMNS.stationNo));
  const station = field(record, FIXED_COLUMNS.station);
  const direction = field(record, FIXED_COLUMNS.direction);

  if (!Number.isFinite(stationNo)) {
    throw new Error(`Bad 역번호 for ${line} ${station}: ${record[FIXED_COLUMNS.stationNo]}`);
  }

  const rows: CongestionRow[] = [];
  for (const col of bucketColumns(Object.keys(record))) {
    const pct = toPct(record[col.key]);
    if (pct === null) continue;
    rows.push({
      dayType,
      line,
      stationNo,
      station,
      direction,
      service: '일반',
      bucket: col.bucket,
      bucketMin: col.bucketMin,
      pct,
    });
  }
  return rows;
}
