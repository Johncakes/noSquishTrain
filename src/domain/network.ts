/**
 * The network as the map needs it: platforms, the track between them, and the
 * rule for which congestion row describes a departure.
 *
 * This is the surviving half of the deleted routing layer. Pathfinding is gone;
 * what remains is the part that was hard to get right and is still needed —
 * which stations are actually connected (the numbering lies at branch
 * junctions), which direction label a hop travels under, and where a
 * second-service platform hides its congestion.
 *
 * All corrections live in topology.ts. Nothing here is guessed.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  CONGESTION_SOURCE,
  EXCLUDED_STATION_NOS,
  EXTRA_EDGES,
  FORWARD_OVERRIDE,
  NON_ADJACENT,
  ONE_WAY,
  baseName,
  directionsFor,
} from './topology.ts';

export interface Platform {
  /** `${line}:${stationNo}` — unique per line, unlike the station name. */
  key: string;
  line: string;
  stationNo: number;
  /** Name as published, e.g. '신촌(지하)'. */
  station: string;
  /** Suffix stripped, used to match the same station across lines. */
  name: string;
}

/** A piece of track between two platforms on one line, for drawing. */
export interface Segment {
  line: string;
  a: number;
  b: number;
  /** True where trains run one way only (응암순환). */
  oneWay: boolean;
}

export interface Network {
  platforms: Platform[];
  byKey: Map<string, Platform>;
  /** Base station name -> every platform serving it. */
  byName: Map<string, Platform[]>;
  segments: Segment[];
  lines: string[];
  /** 상하구분 for travel from one station to the next along the same line. */
  hopDirection(line: string, from: number, to: number): string | null;
  /** 역번호 whose congestion row describes departing `from` toward `to`. */
  congestionStationNo(line: string, from: number, to: number): number;
  /**
   * Both directions served at a platform, each with the row that describes it.
   * This is what the map draws: one half-dot per entry.
   */
  departures(key: string): Departure[];
}

export interface Departure {
  direction: string;
  /** Row to read — differs from the platform's own number at 성수, 신도림, … */
  stationNo: number;
  /** The next station in that direction, for the tooltip. */
  towardName: string;
}

export const platformKey = (line: string, stationNo: number) => `${line}:${stationNo}`;

const hopKey = (line: string, from: number, to: number) => `${line}|${from}-${to}`;

/**
 * Display order for the two directions served at a platform.
 *
 * The map draws them as the left and right half of one dot, so this order must
 * be stable across every station — otherwise "left" would mean 상선 at one stop
 * and 하선 at the next, and the whole inbound/outbound pattern would be noise.
 * Decreasing-역번호 directions come first (left), increasing second (right).
 */
const DIRECTION_ORDER = ['상선', '외선', '하선', '내선'];

export function buildNetwork(db: DatabaseSync): Network {
  const rows = db
    .prepare('SELECT DISTINCT line, station_no, station FROM congestion ORDER BY line, station_no')
    .all() as { line: string; station_no: number; station: string }[];

  const byKey = new Map<string, Platform>();
  const byName = new Map<string, Platform[]>();
  const byLine = new Map<string, Platform[]>();

  for (const row of rows) {
    // 9xxx rows are second-service congestion carriers, not places. Their data
    // is essential (see CONGESTION_SOURCE) but they are never drawn.
    if (EXCLUDED_STATION_NOS[row.line]?.includes(row.station_no)) continue;

    const key = platformKey(row.line, row.station_no);
    // 5호선 2549 is published twice ('강동', '강동(하남검단산)'); one is enough.
    if (byKey.has(key)) continue;

    const platform: Platform = {
      key,
      line: row.line,
      stationNo: row.station_no,
      station: row.station,
      name: baseName(row.station),
    };
    byKey.set(key, platform);

    let named = byName.get(platform.name);
    if (!named) byName.set(platform.name, (named = []));
    named.push(platform);

    let lineList = byLine.get(row.line);
    if (!lineList) byLine.set(row.line, (lineList = []));
    lineList.push(platform);
  }

  const segments: Segment[] = [];
  /** Directed hop -> 상하구분. Built alongside the segments so they cannot drift. */
  const directions = new Map<string, string>();

  const link = (line: string, a: number, b: number, forward: string, backward: string, oneWay: boolean) => {
    segments.push({ line, a, b, oneWay });
    directions.set(hopKey(line, a, b), forward);
    if (!oneWay) directions.set(hopKey(line, b, a), backward);
  };

  // Consecutive numbering is adjacency *most* of the time; NON_ADJACENT names
  // every place it is not.
  for (const [line, platforms] of byLine) {
    const { forward, backward } = directionsFor(line);
    const cuts = new Set((NON_ADJACENT[line] ?? []).map(([a, b]) => `${a}-${b}`));
    const oneWays = new Set((ONE_WAY[line] ?? []).map(([a, b]) => `${a}-${b}`));
    const overrides = new Map((FORWARD_OVERRIDE[line] ?? []).map((o) => [`${o.a}-${o.b}`, o.forward]));

    platforms.sort((x, y) => x.stationNo - y.stationNo);
    for (let i = 1; i < platforms.length; i++) {
      const prev = platforms[i - 1];
      const cur = platforms[i];
      if (cur.stationNo - prev.stationNo !== 1) continue;
      const pair = `${prev.stationNo}-${cur.stationNo}`;
      if (cuts.has(pair)) continue;
      const fwd = overrides.get(pair) ?? forward;
      link(line, prev.stationNo, cur.stationNo, fwd, fwd === forward ? backward : forward, oneWays.has(pair));
    }
  }

  // Track the numbering cannot express: loop closures, branch junctions,
  // stations appended out of physical order.
  for (const [line, extras] of Object.entries(EXTRA_EDGES)) {
    const { forward, backward } = directionsFor(line);
    for (const extra of extras) {
      if (!byKey.has(platformKey(line, extra.a)) || !byKey.has(platformKey(line, extra.b))) {
        throw new Error(`EXTRA_EDGES ${line} ${extra.a}->${extra.b}: unknown station (${extra.note})`);
      }
      const fwd = extra.forward ?? forward;
      link(line, extra.a, extra.b, fwd, fwd === forward ? backward : forward, extra.oneWay === true);
    }
  }

  const sources = new Map<string, number>();
  for (const [line, list] of Object.entries(CONGESTION_SOURCE)) {
    for (const src of list) {
      if (!directions.has(hopKey(line, src.from, src.to))) {
        throw new Error(`CONGESTION_SOURCE ${line} ${src.from}->${src.to}: no such track (${src.note})`);
      }
      sources.set(hopKey(line, src.from, src.to), src.stationNo);
    }
  }

  /** Neighbours reachable from each platform, for enumerating departures. */
  const neighbours = new Map<string, number[]>();
  for (const [key] of directions) {
    const [line, pair] = key.split('|');
    const [from, to] = pair.split('-').map(Number);
    const k = platformKey(line, from);
    let list = neighbours.get(k);
    if (!list) neighbours.set(k, (list = []));
    list.push(to);
  }

  const network: Network = {
    platforms: [...byKey.values()],
    byKey,
    byName,
    segments,
    lines: [...byLine.keys()].sort(),

    hopDirection: (line, from, to) => directions.get(hopKey(line, from, to)) ?? null,

    congestionStationNo: (line, from, to) => sources.get(hopKey(line, from, to)) ?? from,

    departures(key) {
      const platform = byKey.get(key);
      if (!platform) return [];
      const seen = new Set<string>();
      const out: Departure[] = [];
      for (const to of neighbours.get(key) ?? []) {
        const direction = directions.get(hopKey(platform.line, platform.stationNo, to));
        if (!direction || seen.has(direction)) continue;
        seen.add(direction);
        out.push({
          direction,
          stationNo: sources.get(hopKey(platform.line, platform.stationNo, to)) ?? platform.stationNo,
          towardName: byKey.get(platformKey(platform.line, to))?.name ?? String(to),
        });
      }
      return out.sort((a, b) => DIRECTION_ORDER.indexOf(a.direction) - DIRECTION_ORDER.indexOf(b.direction));
    },
  };

  return network;
}
