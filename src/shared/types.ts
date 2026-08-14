/**
 * The wire format between server and browser.
 *
 * Imported by both sides, so a field renamed on the server fails to compile in
 * the page rather than silently arriving as undefined.
 */
import { DAY_SLUGS } from './scale.ts';
import type { DayType } from './scale.ts';

/**
 * Where the payloads live. Declared here beside the shapes they carry, so the
 * page, the local server and the export cannot disagree about a URL.
 *
 * They are plain files under the web root rather than endpoints: nothing about
 * them depends on the request, so nothing has to run to answer one.
 */
export const NETWORK_PATH = '/api/network.json';

export function congestionPath(dayType: DayType): string {
  return `/api/congestion-${DAY_SLUGS[dayType]}.json`;
}

/** A platform placed on the map. Sent once; never changes with time. */
export interface WirePlatform {
  /** `${line}:${stationNo}`. */
  key: string;
  line: string;
  station: string;
  /** Name without the disambiguating suffix, shared across lines. */
  name: string;
  /** 0..1 within the network's bounding box, y pointing south. */
  x: number;
  y: number;
  /** Platforms sharing this exact point, and this one's index among them. */
  shared: number;
  slot: number;
  /**
   * Exactly two slots: [0] is 상행 (상선/외선), [1] is 하행 (하선/내선).
   * Null where no train runs that way — a terminus, or the one-way 응암순환.
   * Fixed slots, never a packed list: at a terminus the only direction present
   * must still land in its own slot or it will be read as the other one.
   */
  directions: [WireDirection | null, WireDirection | null];
}

export interface WireDirection {
  /** 상선 / 하선 / 내선 / 외선. */
  direction: string;
  /** Next station this way, for the tooltip. */
  toward: string;
}

export interface WireSegment {
  line: string;
  /** Endpoints as indices into `platforms`, so the payload stays small. */
  a: number;
  b: number;
}

/**
 * A backdrop ring, projected into the SAME 0..1 space as WirePlatform.x/y.
 *
 * Projecting on the server rather than shipping lon/lat is what guarantees the
 * backdrop lines up with the dots: both go through the one projection built
 * from the station coordinates, so there is no second transform in the page
 * that could drift from it.
 */
export interface WireShape {
  kind: 'water' | 'district';
  points: [number, number][];
}

export interface NetworkPayload {
  /** Period of the lines 1-8 source. */
  quarter: string | null;
  /** Period of the 9호선 file, which is a separate source measured elsewhen. */
  line9Period: string | null;
  coordsVersion: string | null;
  /** Height / width of the network's bounding box. */
  aspect: number;
  lines: string[];
  dayTypes: readonly DayType[];
  buckets: readonly number[];
  platforms: WirePlatform[];
  segments: WireSegment[];
  /** Water and administrative boundaries. Empty until `npm run basemap` runs. */
  basemap: WireShape[];
}

/**
 * Readings for one day type: `values[platform][slot][service][bucket]`.
 *
 * `slot` matches WirePlatform.directions (0 상행, 1 하행). `service` matches
 * SERVICE_SLOTS (0 일반, 1 급행). 급행 exists only on 9호선, so slot 1 is null
 * nearly everywhere — and where it is not, it is a different train, not a
 * refinement of the 일반 number beside it.
 *
 * Three kinds of nothing, all distinct: a null service series means that train
 * does not run here; a null direction means no train runs that way at all; a
 * null inside a series means no published measurement. None is ever zero.
 */
export type ServiceSeries = [(number | null)[] | null, (number | null)[] | null];
export type DirectionSeries = [ServiceSeries | null, ServiceSeries | null];

export interface CongestionPayload {
  dayType: DayType;
  values: DirectionSeries[];
}

/** Index into a ServiceSeries. Mirrors SERVICES in data/normalize.ts. */
export const SERVICE_SLOTS = ['일반', '급행'] as const;
export type ServiceSlot = 0 | 1;
