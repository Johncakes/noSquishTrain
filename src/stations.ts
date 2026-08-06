/**
 * Station registry and direction resolution.
 *
 * What survives from the deleted routing layer: the parts that decide *which
 * congestion row describes a given boarding*. Everything about pathfinding is
 * gone — routes now come from ODsay.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Direction labels for travel in increasing / decreasing 역번호 order. */
export interface DirectionLabels {
  forward: string;
  backward: string;
}

/**
 * Established empirically from terminal stations: at 방화(5), 응암(6) and
 * 장암(7) — each the lowest-numbered stop on its line — 상선 congestion is
 * uniformly 0, because no train departs that way. At 오금(3), the highest
 * number on its line, 하선 is 0 instead. So 하선 = increasing 역번호.
 */
export const DEFAULT_DIRECTIONS: DirectionLabels = { forward: '하선', backward: '상선' };

/** Loop lines label direction by inner/outer circle instead. */
export const LOOP_DIRECTIONS: Record<string, DirectionLabels> = {
  // 내선순환 runs 시청 -> 을지로입구 -> 왕십리 -> 잠실 -> 강남 -> 신도림 -> 시청,
  // which is increasing 역번호 order.
  '2호선': { forward: '내선', backward: '외선' },
};

export const directionsFor = (line: string): DirectionLabels =>
  LOOP_DIRECTIONS[line] ?? DEFAULT_DIRECTIONS;

/**
 * Hops whose direction label runs against numeric order.
 *
 * The 성수지선 counts 외선 all the way toward 신설동 even though its station
 * numbers do not run in path order (성수 211 -> 용답 244 -> 신답 245 ->
 * 용두 250 -> 신설동 246).
 */
const DIRECTION_EXCEPTIONS: Record<string, Record<string, string>> = {
  '2호선': {
    '244-245': '외선', // 용답 -> 신답
    '245-250': '외선', // 신답 -> 용두
    '250-246': '외선', // 용두 -> 신설동
    '246-250': '내선', // 신설동 -> 용두
    '250-245': '내선', // 용두 -> 신답
    '245-244': '내선', // 신답 -> 용답
  },
};

/**
 * Where a boarding's congestion actually lives, when it is not on the
 * station's own row, keyed by the hop `${from}-${to}`.
 *
 * A station serving two services records the second one under a synthetic
 * 9xxx row, leaving its main row at 0 for that direction. Reading the main row
 * would report an empty train and make the leg look ideal.
 */
const CONGESTION_SOURCE: Record<string, Record<string, number>> = {
  '2호선': {
    '211-210': 9001, // 성수E = main-loop 외선 at 성수
    '211-244': 9002, // 성수 = 성수지선 shuttle toward 용답
    '234-247': 9003, // 신도림 = 신정지선 shuttle toward 도림천
  },
  '5호선': {
    '2549-2555': 9005, // 강동(마천) = departure toward 둔촌동
  },
  '6호선': {
    '2611-2612': 9006, // 응암S = 응암순환 loop departure
  },
};

/** Rows that are second-service markers, not stations a user can pick. */
const SYNTHETIC_STATION_NOS: Record<string, number[]> = {
  '2호선': [9001, 9002, 9003],
  '5호선': [9005],
  '6호선': [9006],
};

/**
 * Direction of travel for a single hop.
 *
 * Takes the *immediate next* station, never the leg's final stop: on a loop
 * line the endpoints say nothing about direction. 신도림(234) ->
 * 동대문역사문화공원(205) is 내선, running up through 243 and wrapping to 201,
 * but comparing 205 < 234 would call it 외선 and read a 28-stop detour's data.
 */
export function resolveDirection(line: string, fromNo: number, toNo: number): string {
  const exception = DIRECTION_EXCEPTIONS[line]?.[`${fromNo}-${toNo}`];
  if (exception) return exception;
  const { forward, backward } = directionsFor(line);
  return toNo > fromNo ? forward : backward;
}

/** The 역번호 whose row describes this boarding. */
export function congestionStationNo(line: string, fromNo: number, toNo: number): number {
  return CONGESTION_SOURCE[line]?.[`${fromNo}-${toNo}`] ?? fromNo;
}

export interface Platform {
  line: string;
  stationNo: number;
  /** Name as published, e.g. '신촌(지하)'. */
  station: string;
}

export interface StationRegistry {
  /** Base name -> every platform serving it. */
  byName: Map<string, Platform[]>;
  /** Covered station names, sorted, for the search gate. */
  names: string[];
  lines: string[];
  has(name: string): boolean;
  /** Platform for a station on a specific line, or null when not covered. */
  platform(name: string, line: string): Platform | null;
}

/**
 * Names carry disambiguating suffixes that differ per line ('신촌(지하)',
 * '강동(하남검단산)'). Strip the parenthetical for matching.
 */
export const baseName = (station: string): string =>
  station.replace(/\s*\([^)]*\)\s*$/, '').trim();

export function loadStations(db: DatabaseSync): StationRegistry {
  const rows = db
    .prepare('SELECT DISTINCT line, station_no, station FROM congestion ORDER BY line, station_no')
    .all() as { line: string; station_no: number; station: string }[];

  const byName = new Map<string, Platform[]>();
  const lines = new Set<string>();

  for (const row of rows) {
    if (SYNTHETIC_STATION_NOS[row.line]?.includes(row.station_no)) continue;
    lines.add(row.line);

    const name = baseName(row.station);
    let list = byName.get(name);
    if (!list) byName.set(name, (list = []));
    // 5호선 2549 appears twice ('강동', '강동(하남검단산)'); one platform is enough.
    if (list.some((p) => p.line === row.line && p.stationNo === row.station_no)) continue;
    list.push({ line: row.line, stationNo: row.station_no, station: row.station });
  }

  return {
    byName,
    names: [...byName.keys()].sort((a, b) => a.localeCompare(b, 'ko')),
    lines: [...lines].sort(),
    has: (name) => byName.has(baseName(name.trim())),
    platform(name, line) {
      return byName.get(baseName(name.trim()))?.find((p) => p.line === line) ?? null;
    },
  };
}
