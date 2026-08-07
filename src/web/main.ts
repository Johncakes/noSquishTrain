/**
 * Wiring: fetch, state, and the handful of things that change.
 *
 * State is three values — time bucket, day type, line filter. Everything on
 * screen is a function of those, which is why this needs no framework.
 */
import { DAY_TYPES, bandColorVar, bandLabel, formatClock, type DayType } from '../shared/scale.ts';
import type { CongestionPayload, NetworkPayload } from '../shared/types.ts';
import { createMap, type MapView } from './map.ts';
import { createTimeline } from './timeline.ts';
import { renderLegend } from './legend.ts';

const $ = <T extends Element = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as unknown as T;
};

const statusEl = $('status');

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function boot(): Promise<void> {
  const network = await getJSON<NetworkPayload>('/api/network');

  $('provenance').textContent =
    `혼잡도 ${network.quarter ?? '?'} · 좌표 ${network.coordsVersion ?? '?'} · ${network.platforms.length} platforms`;

  // Day-type payloads are cached after first fetch; there are only three.
  const cache = new Map<DayType, CongestionPayload>();
  const loadDay = async (day: DayType): Promise<CongestionPayload> => {
    const hit = cache.get(day);
    if (hit) return hit;
    const payload = await getJSON<CongestionPayload>(`/api/congestion?day=${encodeURIComponent(day)}`);
    cache.set(day, payload);
    return payload;
  };

  const map: MapView = createMap($<SVGSVGElement>('map'), network);
  renderLegend($('legend'));

  const daySelect = $<HTMLSelectElement>('day');
  for (const day of DAY_TYPES) {
    const option = document.createElement('option');
    option.value = day;
    option.textContent = day;
    daySelect.append(option);
  }

  const lineSelect = $<HTMLSelectElement>('line');
  for (const line of network.lines) {
    const option = document.createElement('option');
    option.value = line;
    option.textContent = line;
    lineSelect.append(option);
  }

  let current = await loadDay('평일');
  let lineFilter: string | null = null;

  const timeline = createTimeline(
    $<HTMLInputElement>('slider'),
    $('clock'),
    $<HTMLButtonElement>('play'),
    network.buckets,
  );

  const tooltip = $('tooltip');
  let hoveredIndex: number | null = null;

  /** Worst reading on screen right now, so the headline follows the filter. */
  function describePeak(bucketIndex: number): string {
    let worst = -1;
    let where = '';
    network.platforms.forEach((platform, i) => {
      if (lineFilter !== null && platform.line !== lineFilter) return;
      current.values[i]?.forEach((series, d) => {
        const pct = series[bucketIndex];
        if (pct !== null && pct !== undefined && pct > worst) {
          worst = pct;
          where = `${platform.name} ${platform.line} ${platform.directions[d]?.direction ?? ''}`;
        }
      });
    });
    return worst < 0 ? 'no readings' : `busiest now: ${where} at ${worst.toFixed(0)}%`;
  }

  function renderTable(bucketIndex: number): void {
    const body = $('table-body');
    const rows: string[] = [];
    network.platforms.forEach((platform, i) => {
      if (lineFilter !== null && platform.line !== lineFilter) return;
      const cells = [0, 1].map((d) => {
        const direction = platform.directions[d];
        if (!direction) return '<td class="none">—</td><td class="none">no service</td>';
        const pct = current.values[i]?.[d]?.[bucketIndex] ?? null;
        return pct === null
          ? '<td class="none">—</td><td class="none">no data</td>'
          : `<td class="num">${pct.toFixed(1)}%</td><td>${direction.direction} ${bandLabel(pct)}</td>`;
      });
      rows.push(`<tr><th scope="row">${platform.name}</th><td>${platform.line}</td>${cells.join('')}</tr>`);
    });
    body.innerHTML = rows.join('');
    $('table-caption').textContent =
      `Readings at ${formatClock(network.buckets[bucketIndex])}, ${daySelect.value}` +
      (lineFilter ? ` — ${lineFilter}` : '') + ` (${rows.length} platforms)`;
  }

  function showTooltip(index: number, clientX: number, clientY: number): void {
    const platform = network.platforms[index];
    const bucket = timeline.index();

    const rows = platform.directions.map((direction, d) => {
      const pct = current.values[index]?.[d]?.[bucket] ?? null;
      const swatch = `<span class="swatch" style="background:${bandColorVar(pct)}"></span>`;
      const value = pct === null ? '—' : `${pct.toFixed(1)}%`;
      const label = pct === null ? 'no data' : bandLabel(pct);
      return `<dt>${swatch}</dt><dd class="pct">${value}</dd><dd class="band">${direction.direction} → ${direction.toward} · ${label}</dd>`;
    });

    if (platform.directions.length < 2) {
      rows.push('<dt></dt><dd class="pct">—</dd><dd class="band">one-way section</dd>');
    }

    tooltip.innerHTML =
      `<div class="tt-title">${platform.station} <span class="tt-line">${platform.line}</span></div>` +
      `<dl>${rows.join('')}</dl>`;
    tooltip.hidden = false;

    // Flip before the edge rather than after, so it never lands off-screen.
    const box = tooltip.getBoundingClientRect();
    const left = clientX + 14 + box.width > window.innerWidth ? clientX - box.width - 14 : clientX + 14;
    const top = clientY + 14 + box.height > window.innerHeight ? clientY - box.height - 14 : clientY + 14;
    tooltip.style.left = `${Math.max(4, left)}px`;
    tooltip.style.top = `${Math.max(4, top)}px`;
  }

  map.onHover((hover) => {
    if (!hover) {
      hoveredIndex = null;
      tooltip.hidden = true;
      return;
    }
    hoveredIndex = hover.platformIndex;
    showTooltip(hover.platformIndex, hover.clientX, hover.clientY);
  });

  function repaint(): void {
    const bucket = timeline.index();
    map.paint(current.values, bucket);
    $('peak-note').textContent = describePeak(bucket);
    if (!$('table-wrap').hidden) renderTable(bucket);
    // Keep an open tooltip truthful while the time moves under it.
    if (hoveredIndex !== null && !tooltip.hidden) {
      const box = tooltip.getBoundingClientRect();
      showTooltip(hoveredIndex, box.left - 14, box.top - 14);
    }
  }

  timeline.onChange(repaint);

  daySelect.addEventListener('change', async () => {
    statusEl.textContent = 'loading…';
    current = await loadDay(daySelect.value as DayType);
    statusEl.textContent = '';
    repaint();
  });

  lineSelect.addEventListener('change', () => {
    lineFilter = lineSelect.value === 'all' ? null : lineSelect.value;
    map.setLineFilter(lineFilter);
    repaint();
  });

  $('toggle-table').addEventListener('click', () => {
    const wrap = $('table-wrap');
    const showing = wrap.hidden;
    wrap.hidden = !showing;
    $('toggle-table').setAttribute('aria-pressed', String(showing));
    $('toggle-table').textContent = showing ? 'Hide table' : 'Show table';
    if (showing) renderTable(timeline.index());
  });

  $('zoom-in').addEventListener('click', () => map.zoomBy(1.4));
  $('zoom-out').addEventListener('click', () => map.zoomBy(1 / 1.4));
  $('zoom-reset').addEventListener('click', () => map.resetZoom());

  // Start at the morning peak: it is the reason to look at this at all.
  const eightAM = network.buckets.indexOf(480);
  timeline.setIndex(eightAM >= 0 ? eightAM : 0);
  repaint();

  statusEl.textContent = '';
}

boot().catch((err) => {
  statusEl.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
});
