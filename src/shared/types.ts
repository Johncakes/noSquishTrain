/**
 * The wire format between server and browser.
 *
 * Imported by both sides, so a field renamed on the server fails to compile in
 * the page rather than silently arriving as undefined.
 */
import type { DayType } from './scale.ts';

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

export interface NetworkPayload {
  quarter: string | null;
  coordsVersion: string | null;
  /** Height / width of the network's bounding box. */
  aspect: number;
  lines: string[];
  dayTypes: readonly DayType[];
  buckets: readonly number[];
  platforms: WirePlatform[];
  segments: WireSegment[];
}

/**
 * Readings for one day type: `values[platformIndex][slot][bucket]`, with slot
 * matching WirePlatform.directions.
 *
 * A null series means no service in that direction; a null inside a series
 * means no published measurement. Neither is ever zero.
 */
export type DirectionSeries = [(number | null)[] | null, (number | null)[] | null];

export interface CongestionPayload {
  dayType: DayType;
  values: DirectionSeries[];
}
