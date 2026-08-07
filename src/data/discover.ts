/**
 * Version discovery for data.go.kr auto-converted file datasets.
 *
 * The portal converts each published file into its own endpoint keyed by a
 * `uddi`, with no date parameter. But it also publishes an OpenAPI spec listing
 * every version, where each path's summary carries the file's date
 * ('..._20260331'). That is enough to resolve "the latest" automatically, so no
 * uddi ever has to be pasted in by hand.
 *
 * Two datasets are used, both from 서울교통공사, and both follow this pattern:
 *   15071311 — 지하철혼잡도정보 (republished quarterly)
 *   15099316 — 1_8호선 역사 좌표(위경도) 정보
 */

/** 지하철혼잡도정보 — the measurements. */
export const NAMESPACE = '15071311/v1';
/** 역사 좌표(위경도) 정보 — where those stations are. */
export const COORDS_NAMESPACE = '15099316/v1';

export const oasUrl = (namespace: string) => `https://infuser.odcloud.kr/oas/docs?namespace=${namespace}`;
export const OAS_URL = oasUrl(NAMESPACE);
export const API_BASE = 'https://api.odcloud.kr/api';

export interface DatasetVersion {
  uddi: string;
  /** Path relative to API_BASE, e.g. '15071311/v1/uddi:...'. */
  path: string;
  title: string;
  /** File date as published, 'YYYYMMDD'. */
  date: string;
  /** Quarter the file date falls in, e.g. '2026Q1'. */
  quarter: string;
}

interface OasDoc {
  paths?: Record<string, { get?: { summary?: string; description?: string } }>;
}

export function quarterOf(yyyymmdd: string): string {
  const year = yyyymmdd.slice(0, 4);
  const month = Number(yyyymmdd.slice(4, 6));
  return `${year}Q${Math.ceil(month / 3)}`;
}

/**
 * All published versions, newest first.
 *
 * Note the dates are not reliably quarter-ends — the series includes a
 * 20251130 file — so ordering is by the actual date string, never by an
 * assumed quarterly cadence.
 */
export async function listVersions(namespace: string = NAMESPACE): Promise<DatasetVersion[]> {
  const url = oasUrl(namespace);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenAPI spec fetch failed: ${res.status} ${res.statusText}`);

  const doc = (await res.json()) as OasDoc;
  const versions: DatasetVersion[] = [];

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const uddi = path.match(/uddi:[0-9a-f-]+/i)?.[0];
    const title = item.get?.summary ?? item.get?.description ?? '';
    const date = title.match(/(\d{8})/)?.[1];
    if (!uddi || !date) continue;

    versions.push({
      uddi,
      path: path.replace(/^\//, ''),
      title: title.trim(),
      date,
      quarter: quarterOf(date),
    });
  }

  if (versions.length === 0) throw new Error(`No dated versions found in ${url}`);
  return versions.sort((a, b) => b.date.localeCompare(a.date));
}

export async function latestVersion(namespace: string = NAMESPACE): Promise<DatasetVersion> {
  return (await listVersions(namespace))[0];
}

/** Read every page of an odcloud dataset. */
export async function fetchAll(path: string, serviceKey: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const url = `${API_BASE}/${path}?page=${page}&perPage=1000&serviceKey=${serviceKey}`;
    const res = await fetch(url);
    const text = await res.text();

    // The portal answers auth failures with HTTP 200 and an error body, so the
    // status code alone cannot be trusted.
    let body: { data?: Record<string, unknown>[]; totalCount?: number; code?: number; msg?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${path} (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (body.code !== undefined || !body.data) {
      throw new Error(`API error from ${path}: ${body.msg ?? text.slice(0, 200)}`);
    }

    out.push(...body.data);
    if (out.length >= (body.totalCount ?? out.length) || body.data.length === 0) return out;
  }
}
