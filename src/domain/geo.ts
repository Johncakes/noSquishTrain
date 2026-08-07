/**
 * Geographic projection and map layout.
 *
 * Seoul spans about 0.3° of latitude, so a plate carrée projection with a
 * cos(latitude) correction on longitude is accurate to well under a pixel at
 * this scale. Anything fancier would be precision the data does not have.
 */
import type { StationCoord } from '../data/coords.ts';
import type { Network, Platform } from './network.ts';

export interface Point {
  /** 0..1 across the bounding box, x east, y south (SVG orientation). */
  x: number;
  y: number;
}

export interface Projection {
  /** Height as a fraction of width, so the aspect ratio survives scaling. */
  aspect: number;
  project(lat: number, lon: number): Point;
}

export function buildProjection(coords: Iterable<StationCoord>): Projection {
  const all = [...coords];
  if (all.length === 0) throw new Error('Cannot project an empty coordinate set');

  const lats = all.map((c) => c.lat);
  const lons = all.map((c) => c.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  const scaleLon = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const width = (maxLon - minLon) * scaleLon;
  const height = maxLat - minLat;

  return {
    aspect: height / width,
    project(lat, lon) {
      return {
        x: ((lon - minLon) * scaleLon) / width,
        // Latitude increases north; SVG y increases down.
        y: (maxLat - lat) / height,
      };
    },
  };
}

/** Rough metres between two coordinates — enough to sanity-check adjacency. */
export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => d * (Math.PI / 180);
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface PlacedPlatform extends Platform, Point {
  lat: number;
  lon: number;
  /** How many platforms share this station's point, including this one. */
  shared: number;
  /** Index within that group, used to fan them out. */
  slot: number;
}

/**
 * Project every platform, fanning out the ones that sit on top of each other.
 *
 * An interchange publishes the same coordinate for each line's platform — 4
 * of them at 왕십리. Drawn raw they overlap into a single unreadable mark, so
 * co-located platforms are spread evenly around a small circle. The offset is
 * applied in screen units by the renderer, not here, because it must not
 * change with zoom.
 */
export function placePlatforms(network: Network, coords: Map<string, StationCoord>, projection: Projection): PlacedPlatform[] {
  const groups = new Map<string, Platform[]>();
  for (const platform of network.platforms) {
    const coord = coords.get(platform.key);
    if (!coord) continue;
    // Group by rounded position, not by name: 서울역 1호선 and 4호선 are one
    // point, while two same-named stations far apart stay separate.
    const groupKey = `${coord.lat.toFixed(5)},${coord.lon.toFixed(5)}`;
    let list = groups.get(groupKey);
    if (!list) groups.set(groupKey, (list = []));
    list.push(platform);
  }

  const placed: PlacedPlatform[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.line.localeCompare(b.line));
    list.forEach((platform, slot) => {
      const coord = coords.get(platform.key)!;
      placed.push({
        ...platform,
        ...projection.project(coord.lat, coord.lon),
        lat: coord.lat,
        lon: coord.lon,
        shared: list.length,
        slot,
      });
    });
  }

  return placed;
}
