/**
 * 9호선 congestion, from the published spreadsheet.
 *
 * Unlike lines 1-8 there is no API for it, so this reads the .xlsx directly.
 * The file differs from the 1-8 source in three ways that all matter:
 *
 *   1. 급행 and 일반 are separate sheets. At a station where both stop they are
 *      different trains — 급행 reaches 186% where the 일반 beside it is under
 *      70% — so they are stored as separate services, never merged.
 *
 *   2. Only 평일 and 휴일 are published, against the 1-8 file's 평일/토요일/
 *      일요일. The 휴일 sheets are measured across a Saturday AND a Sunday
 *      together, so that one series is written to both day types. It is one
 *      measurement presented twice, not two measurements.
 *
 *   3. 상선 and 하선 mean the OPPOSITE of what they mean on lines 1-8. Proven
 *      by the terminus zeros: 개화 (lowest 역번호) has an all-zero 하선 series,
 *      whereas on lines 1-8 the lowest station has an all-zero 상선. See
 *      LINE_DIRECTIONS in topology.ts, which encodes the flip.
 *
 * There is no 역번호 in the file, only names in running order, so numbers are
 * assigned as 901.. along that order — matching the official 9호선 codes.
 */
import { readFileSync } from 'node:fs';
import { readWorkbook, type Sheet } from './xlsx.ts';
import type { CongestionRow, Service } from './normalize.ts';

export const LINE9 = '9호선';
/** 개화 is 901; numbers run east along the line. */
export const FIRST_STATION_NO = 901;

/** Sheet names are `${direction}${service}(${dayType})`. */
const SHEET_PATTERN = /^(상선|하선)(일반|급행)\((평일|휴일)\)$/;

/**
 * 휴일 is measured over one Saturday and one Sunday together, so it is the best
 * available answer for both — but it is a single series, and the ingest report
 * says so rather than implying two independent measurements.
 */
const HOLIDAY_DAY_TYPES = ['토요일', '일요일'] as const;

export interface Line9Report {
  rows: CongestionRow[];
  /** Station names in running order, index 0 == 역번호 901. */
  stations: string[];
  /** Series dropped because every bucket was zero — a terminus, not a quiet train. */
  droppedAllZero: string[];
  /** Which sheets were read, for the audit trail. */
  sheets: string[];
  /** '기준일자' notes found in the file. */
  basis: string[];
  /** Buckets a sheet omits entirely, e.g. holiday service ending earlier. */
  bucketCounts: Record<string, number>;
}

/** '05:30~05:59' -> the bucket it starts, in minutes from midnight. */
function parseRangeLabel(label: string): { bucket: string; bucketMin: number } | null {
  const m = label.trim().match(/^(\d{1,2}):(\d{2})\s*~/);
  if (!m) return null;

  const rawHour = Number(m[1]);
  const minute = Number(m[2]);
  // The service day runs 05:30 -> 00:30, so the small hours belong to the
  // following calendar day and sort after 1440, exactly as in normalize.ts.
  const hour = rawHour < 4 ? rawHour + 24 : rawHour;

  return {
    bucket: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    bucketMin: hour * 60 + minute,
  };
}

/** Column letters of a sheet's time header, paired with the bucket they mean. */
function timeColumns(sheet: Sheet): { column: string; bucket: string; bucketMin: number }[] {
  const header = sheet.get(2);
  if (!header) throw new Error('Sheet has no header row at row 2');

  const columns: { column: string; bucket: string; bucketMin: number }[] = [];
  for (const [column, label] of header) {
    if (column === 'A') continue;
    const parsed = parseRangeLabel(label);
    if (parsed) columns.push({ column, ...parsed });
  }
  columns.sort((a, b) => a.bucketMin - b.bucketMin);

  if (columns.length === 0) throw new Error('Sheet header row 2 has no recognisable time ranges');
  return columns;
}

/** Station names down column A, from row 3. */
function stationRows(sheet: Sheet): { row: number; station: string }[] {
  const out: { row: number; station: string }[] = [];
  for (const [row, cells] of [...sheet].sort((a, b) => a[0] - b[0])) {
    if (row < 3) continue;
    const station = cells.get('A')?.trim();
    // The file ends with a '(기준일자 : ...)' note in column A; it has no data.
    if (!station || station.startsWith('(')) continue;
    out.push({ row, station });
  }
  return out;
}

export function readLine9(path: string): Line9Report {
  const workbook = readWorkbook(readFileSync(path));

  // The 일반 sheets carry every station; 급행 carries only the express stops.
  // Numbering therefore comes from 일반, and 급행 is matched into it by name.
  const localSheet = workbook.sheets.get('상선일반(평일)');
  if (!localSheet) throw new Error("Missing sheet '상선일반(평일)' — is this the 9호선 congestion file?");

  const stations = stationRows(localSheet).map((s) => s.station);
  const numberOf = new Map(stations.map((name, i) => [name, FIRST_STATION_NO + i]));

  const rows: CongestionRow[] = [];
  const droppedAllZero: string[] = [];
  const sheets: string[] = [];
  const bucketCounts: Record<string, number> = {};

  // The '기준일자' notes are in the shared-string table but referenced by no
  // cell — they sit in a header or text box. They are still the only statement
  // of which week was measured, so they are read from there.
  const basis = new Set(workbook.strings.filter((s) => s.includes('기준일자')).map((s) => s.trim()));

  for (const [name, sheet] of workbook.sheets) {
    const match = name.match(SHEET_PATTERN);
    if (!match) throw new Error(`Unexpected sheet '${name}' — expected e.g. 상선일반(평일)`);

    const [, direction, service, dayLabel] = match as unknown as [string, string, Service, string];
    sheets.push(name);

    const columns = timeColumns(sheet);
    bucketCounts[name] = columns.length;
    const dayTypes = dayLabel === '휴일' ? [...HOLIDAY_DAY_TYPES] : [dayLabel];

    for (const { row, station } of stationRows(sheet)) {
      const stationNo = numberOf.get(station);
      if (stationNo === undefined) {
        throw new Error(`'${name}' row ${row}: station '${station}' is not in the 일반 station list`);
      }

      const series = columns.map((c) => {
        const raw = sheet.get(row)?.get(c.column);
        if (raw === undefined || raw.trim() === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      });

      // A series that is zero in every bucket is a terminus with no departure
      // that way — not an empty train. Storing it would hand the map a 0% that
      // reads as "wonderfully quiet" at exactly the place trains do not run.
      const measured = series.filter((v): v is number => v !== null);
      if (measured.length > 0 && measured.every((v) => v === 0)) {
        droppedAllZero.push(`${name} ${station}`);
        continue;
      }

      for (const dayType of dayTypes) {
        columns.forEach((c, i) => {
          const pct = series[i];
          if (pct === null) return;
          rows.push({
            dayType,
            line: LINE9,
            stationNo,
            station,
            direction,
            service,
            bucket: c.bucket,
            bucketMin: c.bucketMin,
            pct,
          });
        });
      }
    }
  }

  if (rows.length === 0) throw new Error('No 9호선 rows parsed — the file layout may have changed');

  return { rows, stations, droppedAllZero, sheets, basis: [...basis], bucketCounts };
}
