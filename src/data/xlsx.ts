/**
 * A minimal .xlsx reader — just enough to read a published spreadsheet.
 *
 * An .xlsx is a ZIP of XML. Node ships raw DEFLATE in node:zlib, so reading one
 * needs no dependency: walk the ZIP central directory, inflate the few entries
 * that matter, and pull values out of the sheet XML.
 *
 * This exists because 9호선 congestion is published only as a file — there is
 * no API for it, unlike lines 1-8. Adding a spreadsheet library for one file a
 * year is a worse trade than 150 lines that do exactly what is needed.
 *
 * Scope, deliberately: no formulas, no styles, no dates, no streaming. Cell
 * values come back as raw strings, with shared strings resolved.
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Every file in the archive, by name. */
export function unzip(buffer: Buffer): Map<string, Buffer> {
  // The end-of-central-directory record sits at the end, after a comment of
  // unknown length, so it has to be found by scanning backwards.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 0xffff; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive: no end-of-central-directory record');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`Corrupt ZIP: bad central directory entry at ${offset}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    // The local header repeats the name and extra field, and its extra field
    // length can differ from the central one — so read it, do not assume.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`${name}: unsupported ZIP compression method ${method}`);

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function decodeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/**
 * The shared string table.
 *
 * A string may be split across several <t> runs inside one <si> when parts of
 * it are formatted differently; concatenating the runs is what reassembles it.
 */
function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    const runs = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
    out.push(runs.join(''));
  }
  return out;
}

/** One sheet as rows of column-letter -> value, 1-based row numbers. */
export type Sheet = Map<number, Map<string, string>>;

function readSheet(xml: string, shared: string[]): Sheet {
  const rows: Sheet = new Map();

  for (const rowMatch of xml.matchAll(/<row[^>]*\sr="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(rowMatch[1]);
    const cells = new Map<string, string>();

    for (const cellMatch of rowMatch[2].matchAll(/<c\s+r="([A-Z]+)\d+"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const column = cellMatch[1];
      const attributes = cellMatch[2];
      const body = cellMatch[3] ?? '';

      // An inline string carries its text directly instead of via the table.
      if (/t="inlineStr"/.test(attributes)) {
        const runs = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
        if (runs.length) cells.set(column, runs.join(''));
        continue;
      }

      const value = body.match(/<v>([\s\S]*?)<\/v>/);
      if (!value) continue;
      const raw = decodeXml(value[1]);

      if (/t="s"/.test(attributes)) {
        const resolved = shared[Number(raw)];
        if (resolved === undefined) throw new Error(`Shared string ${raw} out of range`);
        cells.set(column, resolved);
      } else {
        cells.set(column, raw);
      }
    }

    rows.set(rowNumber, cells);
  }

  return rows;
}

export interface Workbook {
  /** Sheets in workbook order, by their visible name. */
  sheets: Map<string, Sheet>;
  /**
   * The whole shared-string table.
   *
   * Exposed because a string can live in the file without any cell referencing
   * it — Excel keeps header, footer and text-box content here too. The 9호선
   * file's '기준일자' provenance notes are exactly that, and they are the only
   * record of which week the data covers.
   */
  strings: string[];
}

export function readWorkbook(buffer: Buffer): Workbook {
  const files = unzip(buffer);

  const workbookXml = files.get('xl/workbook.xml')?.toString('utf8');
  if (!workbookXml) throw new Error('Not an .xlsx: xl/workbook.xml is missing');

  const relsXml = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const targetById = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship([^>]*)\/>/g)) {
    const id = m[1].match(/Id="([^"]+)"/)?.[1];
    const target = m[1].match(/Target="([^"]+)"/)?.[1];
    if (id && target) targetById.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8');
  const shared = sharedXml ? readSharedStrings(sharedXml) : [];

  const sheets = new Map<string, Sheet>();
  for (const m of workbookXml.matchAll(/<sheet([^>]*)\/>/g)) {
    const name = m[1].match(/name="([^"]+)"/)?.[1];
    const relationId = m[1].match(/r:id="([^"]+)"/)?.[1];
    if (!name || !relationId) continue;

    const target = targetById.get(relationId);
    if (!target) throw new Error(`Sheet '${name}' points at unknown relationship ${relationId}`);

    const xml = files.get(`xl/${target}`)?.toString('utf8');
    if (!xml) throw new Error(`Sheet '${name}' file xl/${target} is missing from the archive`);

    sheets.set(decodeXml(name), readSheet(xml, shared));
  }

  if (sheets.size === 0) throw new Error('Workbook contains no sheets');
  return { sheets, strings: shared };
}
