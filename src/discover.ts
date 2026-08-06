/**
 * Version discovery for data.go.kr dataset 15071311.
 *
 * The portal auto-converts each published file into its own endpoint keyed by
 * a `uddi`, with no date parameter. But it also publishes an OpenAPI spec
 * listing every version, where each path's summary carries the file's date
 * ('..._20260331'). That is enough to resolve "the latest" automatically, so
 * the uddi does not have to be pasted in by hand each quarter.
 */

export const NAMESPACE = '15071311/v1';
export const OAS_URL = `https://infuser.odcloud.kr/oas/docs?namespace=${NAMESPACE}`;
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
export async function listVersions(): Promise<DatasetVersion[]> {
  const res = await fetch(OAS_URL);
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

  if (versions.length === 0) throw new Error(`No dated versions found in ${OAS_URL}`);
  return versions.sort((a, b) => b.date.localeCompare(a.date));
}

export async function latestVersion(): Promise<DatasetVersion> {
  return (await listVersions())[0];
}
