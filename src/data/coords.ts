/**
 * Station coordinates, from data.go.kr 15099316
 * (서울교통공사_1_8호선 역사 좌표(위경도) 정보).
 *
 * Same publisher as the congestion data, and it carries the same
 * 고유역번호(외부역코드) — which makes joining on the number look obvious and
 * makes it wrong. On 6호선 the coordinate file places 봉화산 at 2615, but the
 * congestion file has it at 2648 (correct: it sits between 화랑대 and 신내).
 * That single displacement shifts every station from 연신내 onward by one slot,
 * so 34 of 39 stations on the line would be drawn at their neighbour's
 * position — a map that looks entirely plausible and is silently wrong.
 *
 * So the join is by NAME within a line, and the station number is then checked
 * against it. Disagreements are reported, not absorbed. If a future file shifts
 * a different line, `npm run coords` says so instead of drawing it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { COORDS_NAMESPACE, fetchAll, latestVersion } from './discover.ts';
import { baseName } from '../domain/topology.ts';
import { LINE9 } from './line9.ts';

export interface StationCoord {
  line: string;
  stationNo: number;
  station: string;
  lat: number;
  lon: number;
  /** How this coordinate was obtained, for the audit trail. */
  source: 'file' | 'file:renamed' | 'override' | 'shared-platform' | 'line9-table';
}

/**
 * Stations renamed since the coordinate file was published, as
 * `${line}|${our name}` -> the name that file uses.
 *
 * Each was verified to sit at the same 역번호 in both files, so these are
 * genuine renames and not a numbering shift.
 */
const RENAMED: Record<string, string> = {
  '1호선|서울역': '서울',
  '4호선|서울역': '서울',
  '4호선|불암산': '당고개', // renamed 2024
  '7호선|자양': '뚝섬유원지', // 자양(뚝섬한강공원), renamed 2023
  '7호선|이수': '총신대입구', // same interchange, different name per line
};

/**
 * Coordinates the file gets wrong or omits. These win over the file.
 *
 * Every entry is a measured failure, not a preference — `npm run check`
 * rejected the file's value because it put adjacent stations kilometres apart.
 * Sources are the Korean Wikipedia station articles.
 */
const OVERRIDES: Record<string, { lat: number; lon: number; why: string }> = {
  // Opened 2024-08-10 on the 별내선 extension, still absent from the
  // 2025-08-14 file. Sits just northeast of 암사, which is where the line runs.
  '8호선|암사역사공원': { lat: 37.55667, lon: 127.13556, why: 'absent from the file' },

  // The file puts 용답 at 126.9779 — about 6.4km west of where it is, near
  // 충정로. That made 성수 -> 용답 read as a 7.3km hop on a branch whose real
  // spacing is 2.3km.
  '2호선|용답': { lat: 37.562139, lon: 127.050833, why: 'file value 6.4km west of the real station' },

  // Same branch: the file's 신답 is ~1.2km southeast of the real station.
  '2호선|신답': { lat: 37.57, lon: 127.04639, why: 'file value 1.2km from the real station' },
};

/**
 * 9호선 coordinates. The published file covers lines 1-8 only, and there is no
 * equivalent for 9호선, so these come from the Korean and English Wikipedia
 * station articles.
 *
 * Only the 30 stations that 9호선 does NOT share with lines 1-8 are listed. The
 * other eight — 김포공항, 당산, 여의도, 동작, 고속터미널, 종합운동장, 석촌,
 * 올림픽공원 — deliberately have no entry: they are resolved by reusing the
 * exact coordinate already loaded for the other line. That is not just tidier,
 * it is required. The map groups platforms into one station by rounded
 * position, so a value even slightly different would split 당산 into two
 * stations sitting next to each other instead of one interchange.
 */
const LINE9_COORDS: Record<string, { lat: number; lon: number }> = {
  개화: { lat: 37.57861111, lon: 126.79833333 },
  공항시장: { lat: 37.56361111, lon: 126.81027778 },
  신방화: { lat: 37.5675, lon: 126.81666667 },
  마곡나루: { lat: 37.56972222, lon: 126.83 },
  양천향교: { lat: 37.56833333, lon: 126.84138889 },
  가양: { lat: 37.56111111, lon: 126.85527778 },
  증미: { lat: 37.5575, lon: 126.86166667 },
  등촌: { lat: 37.55111111, lon: 126.86472222 },
  염창: { lat: 37.54694444, lon: 126.87472222 },
  신목동: { lat: 37.54416667, lon: 126.88305556 },
  선유도: { lat: 37.53777778, lon: 126.89388889 },
  국회의사당: { lat: 37.52861111, lon: 126.9175 },
  샛강: { lat: 37.5175, lon: 126.92805556 },
  // 노량진 is a 1호선 interchange, but our 1호선 coverage stops at 서울역~청량리,
  // so there is no file coordinate to reuse.
  노량진: { lat: 37.51444444, lon: 126.94277778 },
  노들: { lat: 37.512726, lon: 126.953096 },
  흑석: { lat: 37.50888889, lon: 126.96361111 },
  구반포: { lat: 37.50138889, lon: 126.98722222 },
  신반포: { lat: 37.50333333, lon: 126.99583333 },
  사평: { lat: 37.50416111, lon: 127.01521944 },
  신논현: { lat: 37.50444444, lon: 127.02444444 },
  언주: { lat: 37.5072, lon: 127.0339 },
  선정릉: { lat: 37.5103, lon: 127.04385 },
  삼성중앙: { lat: 37.5128, lon: 127.0525 },
  봉은사: { lat: 37.514219, lon: 127.060271 },
  삼전: { lat: 37.50453056, lon: 127.08721111 },
  석촌고분: { lat: 37.50243889, lon: 127.09661111 },
  송파나루: { lat: 37.51125, lon: 127.11278889 },
  한성백제: { lat: 37.51666944, lon: 127.11621111 },
  둔촌오륜: { lat: 37.51983889, lon: 127.13841944 },
  중앙보훈병원: { lat: 37.52880658, lon: 127.14848757 },
};

interface CoordRecord {
  호선: number;
  '고유역번호(외부역코드)': number;
  역명: string;
  위도: string;
  경도: string;
}

export interface CoordReport {
  coords: StationCoord[];
  /** Rows whose name matched but whose 역번호 disagreed — the 6호선 case. */
  numberMismatches: { line: string; station: string; ours: number; theirs: number }[];
  version: string;
  overrides: { key: string; why: string }[];
  unusedRenames: string[];
  unusedOverrides: string[];
  /** 9호선 stations resolved by reusing another line's coordinate. */
  reusedFromOtherLine: string[];
  /** 9호선 stations taken from LINE9_COORDS. */
  fromLine9Table: string[];
}

export async function fetchCoords(db: DatabaseSync, serviceKey: string): Promise<CoordReport> {
  const version = await latestVersion(COORDS_NAMESPACE);
  const raw = (await fetchAll(version.path, serviceKey)) as unknown as CoordRecord[];

  // Index the file by (line, name). Names are unique within a line.
  const byLineName = new Map<string, CoordRecord>();
  for (const r of raw) {
    byLineName.set(`${r['호선']}호선|${baseName(r['역명'])}`, r);
  }

  const platforms = db
    .prepare('SELECT DISTINCT line, station_no, station FROM congestion WHERE station_no < 9000 ORDER BY line, station_no')
    .all() as { line: string; station_no: number; station: string }[];

  // Lines 1-8 first, so a 9호선 interchange can reuse a coordinate that is
  // already resolved rather than needing its own near-duplicate.
  platforms.sort((a, b) => Number(a.line === LINE9) - Number(b.line === LINE9));

  const coords: StationCoord[] = [];
  const numberMismatches: CoordReport['numberMismatches'] = [];
  const overrides: CoordReport['overrides'] = [];
  const usedRenames = new Set<string>();
  const usedOverrides = new Set<string>();
  const missing: string[] = [];
  const seen = new Set<string>();
  const reusedFromOtherLine: string[] = [];
  const fromLine9Table: string[] = [];
  /** Base name -> coordinate already resolved on some other line. */
  const resolvedByName = new Map<string, { lat: number; lon: number }>();

  for (const p of platforms) {
    const key = `${p.line}:${p.station_no}`;
    if (seen.has(key)) continue; // 5호선 2549 is published twice
    seen.add(key);

    const ourName = baseName(p.station);
    const lookupKey = `${p.line}|${ourName}`;

    // 9호선 is not in the published file at all.
    if (p.line === LINE9) {
      const shared = resolvedByName.get(ourName);
      const manual = LINE9_COORDS[ourName];
      const point = shared ?? manual;
      if (!point) {
        missing.push(`${p.line} ${p.station_no} ${p.station}`);
        continue;
      }
      (shared ? reusedFromOtherLine : fromLine9Table).push(ourName);
      coords.push({
        line: p.line, stationNo: p.station_no, station: p.station,
        lat: point.lat, lon: point.lon,
        source: shared ? 'shared-platform' : 'line9-table',
      });
      continue;
    }

    // An override wins outright — it exists because the file's value was
    // measured to be wrong, so there is nothing to reconcile with.
    const override = OVERRIDES[lookupKey];
    if (override) {
      usedOverrides.add(lookupKey);
      overrides.push({ key: lookupKey, why: override.why });
      resolvedByName.set(ourName, { lat: override.lat, lon: override.lon });
      coords.push({
        line: p.line, stationNo: p.station_no, station: p.station,
        lat: override.lat, lon: override.lon, source: 'override',
      });
      continue;
    }

    const renamed = RENAMED[lookupKey];
    if (renamed) usedRenames.add(lookupKey);

    const record = byLineName.get(renamed ? `${p.line}|${renamed}` : lookupKey);
    if (!record) {
      missing.push(`${p.line} ${p.station_no} ${p.station}`);
      continue;
    }

    const theirNo = record['고유역번호(외부역코드)'];
    if (theirNo !== p.station_no) {
      numberMismatches.push({ line: p.line, station: ourName, ours: p.station_no, theirs: theirNo });
    }

    const lat = Number(record['위도']);
    const lon = Number(record['경도']);
    // Seoul sits near 37.4-37.8N, 126.7-127.3E. Anything outside means the
    // columns moved or a value is malformed.
    if (!(lat > 37 && lat < 38 && lon > 126 && lon < 128)) {
      throw new Error(`Implausible coordinate for ${p.line} ${p.station}: ${lat}, ${lon}`);
    }

    resolvedByName.set(ourName, { lat, lon });
    coords.push({
      line: p.line,
      stationNo: p.station_no,
      station: p.station,
      lat,
      lon,
      source: renamed ? 'file:renamed' : 'file',
    });
  }

  if (missing.length) {
    throw new Error(
      `No coordinate for ${missing.length} station(s):\n  ${missing.join('\n  ')}\n` +
        'Add them to OVERRIDES (lines 1-8) or LINE9_COORDS in src/data/coords.ts with a cited source.',
    );
  }

  return {
    coords,
    numberMismatches,
    version: version.date,
    overrides,
    unusedRenames: Object.keys(RENAMED).filter((k) => !usedRenames.has(k)),
    unusedOverrides: Object.keys(OVERRIDES).filter((k) => !usedOverrides.has(k)),
    reusedFromOtherLine,
    fromLine9Table,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS station_coords (
  line       TEXT    NOT NULL,
  station_no INTEGER NOT NULL,
  station    TEXT    NOT NULL,
  lat        REAL    NOT NULL,
  lon        REAL    NOT NULL,
  source     TEXT    NOT NULL,
  PRIMARY KEY (line, station_no)
) WITHOUT ROWID;
`;

export function ensureCoordSchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
}

export function replaceCoords(db: DatabaseSync, coords: StationCoord[]): number {
  if (coords.length === 0) throw new Error('Refusing to replace coordinates with zero rows');
  ensureCoordSchema(db);

  const insert = db.prepare(
    'INSERT OR REPLACE INTO station_coords (line, station_no, station, lat, lon, source) VALUES (?, ?, ?, ?, ?, ?)',
  );

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM station_coords');
    for (const c of coords) insert.run(c.line, c.stationNo, c.station, c.lat, c.lon, c.source);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return coords.length;
}

export function loadCoords(db: DatabaseSync): Map<string, StationCoord> {
  ensureCoordSchema(db);
  const rows = db.prepare('SELECT line, station_no, station, lat, lon, source FROM station_coords').all() as {
    line: string; station_no: number; station: string; lat: number; lon: number; source: string;
  }[];

  return new Map(
    rows.map((r) => [
      `${r.line}:${r.station_no}`,
      { line: r.line, stationNo: r.station_no, station: r.station, lat: r.lat, lon: r.lon, source: r.source as StationCoord['source'] },
    ]),
  );
}
