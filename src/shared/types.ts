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
  /** Directions served here, in display order. */
  directions: WireDirection[];
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
 * Readings for one day type: `values[platformIndex][directionIndex][bucket]`.
 * Null means the dataset has no row — which is never the same as zero.
 */
export interface CongestionPayload {
  dayType: DayType;
  values: (number | null)[][][];
}
