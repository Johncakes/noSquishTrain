/**
 * Network topology corrections.
 *
 * The congestion dataset has no notion of track layout — only (line, 역번호).
 * Station numbers run in physical order along each line's trunk, so
 * consecutive numbers are adjacent *most* of the time. They are not adjacent
 * across branch junctions, where the numbering keeps counting but the rails
 * diverge. Those cases are corrected explicitly below.
 *
 * Everything here is hand-derived from the real network. `npm run graph:check`
 * validates the result (connectivity, degrees, known transfers) so a mistake
 * surfaces rather than silently producing impossible routes.
 */

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

export function directionsFor(line: string): DirectionLabels {
  return LOOP_DIRECTIONS[line] ?? DEFAULT_DIRECTIONS;
}

/**
 * Rows that are not distinct stations: they duplicate a real station under a
 * synthetic 9xxx number to carry congestion for a *second service* at that
 * platform. They are not graph nodes, but their congestion is essential —
 * see CONGESTION_SOURCE.
 */
export const EXCLUDED_STATION_NOS: Record<string, number[]> = {
  '2호선': [9001, 9002, 9003],
  '5호선': [9005],
  '6호선': [9006],
};

/**
 * Consecutively-numbered pairs that are NOT connected by track.
 * Written as [lower, higher] 역번호 on the given line.
 */
export const NON_ADJACENT: Record<string, [number, number][]> = {
  '1호선': [
    // 동묘앞 opened in 2005 and was appended to the numbering as 159, but it
    // sits physically between 동대문(155) and 신설동(156).
    [155, 156],
    [158, 159], // 청량리 -> 동묘앞: opposite ends of the line
  ],
  '8호선': [
    // 남위례 opened in 2021 and was appended as 2828, but sits between
    // 복정(2821) and 산성(2822).
    [2821, 2822],
    [2827, 2828], // 모란 (terminus) -> 남위례
  ],
  '2호선': [
    [243, 244], // 충정로 (loop end) -> 용답 (성수지선 start)
    [245, 246], // 신답 -> 신설동: the branch runs 신답 -> 용두 -> 신설동
    [246, 247], // 신설동 (성수지선 end) -> 도림천 (신정지선 start)
    [249, 250], // 신정네거리 -> 용두: different branches entirely
  ],
  '5호선': [
    [2554, 2555], // 상일동 (하남 branch) -> 둔촌동 (마천 branch)
    [2561, 2562], // 마천 (branch end) -> 강일 (하남 branch continuation)
  ],
  '6호선': [
    [2616, 2617], // 구산 -> 새절: the 응암순환 loop passes through 응암 between them
  ],
};

/**
 * Consecutively-numbered pairs that ARE adjacent, but whose direction label
 * runs against numeric order. Distinct from NON_ADJACENT, which means there
 * is no track at all.
 */
export interface ForwardOverride {
  a: number;
  b: number;
  forward: string;
  note: string;
}

export const FORWARD_OVERRIDE: Record<string, ForwardOverride[]> = {
  '2호선': [
    // On the 성수지선 the whole branch counts 외선 toward 신설동, so this hop
    // is 외선 even though 244 -> 245 increases.
    { a: 244, b: 245, forward: '외선', note: '용답 -> 신답, 성수지선' },
  ],
};

/**
 * Sections served in one direction only, as [from, to] 역번호.
 *
 * The dataset proves this rather than merely suggesting it: 역촌, 불광,
 * 독바위, 연신내 and 구산 carry 하선 rows and nothing else, because the
 * 응암순환 is a one-way loop. Building these bidirectionally would invent
 * services that do not exist and legs that can never be scored.
 */
export const ONE_WAY: Record<string, [number, number][]> = {
  '6호선': [
    [2611, 2612], // 응암 -> 역촌
    [2612, 2613], // 역촌 -> 불광
    [2613, 2614], // 불광 -> 독바위
    [2614, 2615], // 독바위 -> 연신내
    [2615, 2616], // 연신내 -> 구산
  ],
};

/**
 * Track connections the numbering does not express.
 * `forward` names the direction label for travel from `a` to `b`; it defaults
 * to the line's increasing-number label when omitted.
 */
export interface ExtraEdge {
  a: number;
  b: number;
  note: string;
  forward?: string;
  oneWay?: boolean;
}

export const EXTRA_EDGES: Record<string, ExtraEdge[]> = {
  '1호선': [
    { a: 155, b: 159, note: '동대문 -> 동묘앞' },
    // Runs against numeric order, so its label cannot be inferred.
    { a: 159, b: 156, note: '동묘앞 -> 신설동', forward: '하선' },
  ],
  '8호선': [
    { a: 2821, b: 2828, note: '복정 -> 남위례' },
    { a: 2828, b: 2822, note: '남위례 -> 산성', forward: '하선' },
  ],
  '2호선': [
    { a: 243, b: 201, note: '충정로 -> 시청, closes the main loop' },
    // 성수지선: 성수 -> 용답 -> 신답 -> 용두 -> 신설동.
    // Travel toward 신설동 is 외선, toward 성수 is 내선 — proven by 신설동
    // being a terminus whose only departure is 내선 (48.4%), with congestion
    // rising 48 -> 55 -> 66 -> 75 toward 성수 as commuters join the main loop.
    { a: 211, b: 244, note: '성수 -> 용답, 성수지선 junction', forward: '외선' },
    { a: 245, b: 250, note: '신답 -> 용두', forward: '외선' },
    { a: 250, b: 246, note: '용두 -> 신설동', forward: '외선' },
    // 신정지선: 신도림 -> 도림천 -> 양천구청 -> 신정네거리 -> 까치산
    { a: 234, b: 247, note: '신도림 -> 도림천, 신정지선 junction' },
    { a: 249, b: 260, note: '신정네거리 -> 까치산' },
  ],
  '5호선': [
    { a: 2549, b: 2555, note: '강동 -> 둔촌동, 마천 branch junction' },
    { a: 2554, b: 2562, note: '상일동 -> 강일, 하남 extension' },
  ],
  '6호선': [
    // Closes the one-way loop; runs against numeric order, so it is still 하선.
    { a: 2616, b: 2611, note: '구산 -> 응암, closes 응암순환', forward: '하선', oneWay: true },
    { a: 2611, b: 2617, note: '응암 -> 새절, trunk after the loop' },
  ],
};

/**
 * Transfer matching is by station name, but names carry disambiguating
 * suffixes that differ per line ('신촌(지하)', '강동(하남검단산)',
 * '올림픽공원(한국체대)'). Strip the parenthetical to get the base name.
 */
export function baseName(station: string): string {
  return station.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Where a departure's congestion actually lives, when it is not on the
 * station's own row.
 *
 * A station serving two services has its second service recorded under a
 * synthetic 9xxx row, leaving the main row at 0 for that direction. Reading
 * the main row would report an empty train and make the leg look ideal — the
 * single most dangerous failure mode for a crowding-aware planner, because it
 * is invisible and it actively attracts routes.
 *
 * Established by matching each synthetic row against its neighbours:
 * 성수E 외선 (34.4) sits between 뚝섬 (35.8) and 건대입구 (35.1), so it is the
 * main loop; 성수 9002 외선 (18.9) matches the branch (15-17), so it is the
 * shuttle.
 */
export interface CongestionSource {
  from: number;
  to: number;
  stationNo: number;
  note: string;
}

export const CONGESTION_SOURCE: Record<string, CongestionSource[]> = {
  '2호선': [
    { from: 211, to: 210, stationNo: 9001, note: '성수E = main-loop 외선 at 성수' },
    { from: 211, to: 244, stationNo: 9002, note: '성수 = 성수지선 shuttle toward 용답' },
    { from: 234, to: 247, stationNo: 9003, note: '신도림 = 신정지선 shuttle toward 도림천' },
  ],
  '5호선': [
    { from: 2549, to: 2555, stationNo: 9005, note: '강동(마천) = departure toward 둔촌동' },
  ],
  '6호선': [
    { from: 2611, to: 2612, stationNo: 9006, note: '응암S = 응암순환 loop departure' },
  ],
};

/** Minutes assumed per station hop. The dataset carries no timetable. */
export const RIDE_MINUTES = 2;

/** Minutes assumed per line change: walking the interchange plus waiting. */
export const TRANSFER_MINUTES = 4;
