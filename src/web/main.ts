/**
 * Wiring: fetch, state, and the handful of things that change.
 *
 * State is three values — time bucket, day type, line filter. Everything on
 * screen is a function of those, which is why this needs no framework.
 */
import { BANDS, DAY_TYPES, bandColorVar, bandIndex, bandLabel, formatClock, type DayType } from '../shared/scale.ts';
import { NETWORK_PATH, SERVICE_SLOTS, congestionPath } from '../shared/types.ts';
import type { CongestionPayload, NetworkPayload } from '../shared/types.ts';
import { createMap, readingFor, type DirectionMode, type MapView, type ServiceMode } from './map.ts';
import { createTimeline } from './timeline.ts';
import { DIRECTION_SLOT_LABELS, renderLegend } from './legend.ts';

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
  const network = await getJSON<NetworkPayload>(NETWORK_PATH);

  // Two congestion sources measured in different periods, so both are named
  // rather than implying one date covers the whole map.
  $('provenance').textContent =
    `1–8호선 ${network.quarter ?? '?'} · 9호선 ${network.line9Period ?? '?'} · ` +
    `좌표 ${network.coordsVersion ?? '?'} · ${network.platforms.length} platforms`;

  // Day-type payloads are cached after first fetch; there are only three.
  const cache = new Map<DayType, CongestionPayload>();
  const loadDay = async (day: DayType): Promise<CongestionPayload> => {
    const hit = cache.get(day);
    if (hit) return hit;
    const payload = await getJSON<CongestionPayload>(congestionPath(day));
    cache.set(day, payload);
    return payload;
  };

  const map: MapView = createMap($<SVGSVGElement>('map'), network);

  const daySelect = $<HTMLSelectElement>('day');
  for (const day of DAY_TYPES) {
    const option = document.createElement('option');
    option.value = day;
    option.textContent = day;
    daySelect.append(option);
  }

  // Built from BANDS rather than hard-coded in the HTML, so the options can
  // never drift from the thresholds the colours actually use.
  const thresholdSelect = $<HTMLSelectElement>('threshold');
  BANDS.forEach((band, i) => {
    if (i === 0) return; // "0% 이상" is every station — that is the 전체 option
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = i === BANDS.length - 1 ? band.label : `${band.label} 이상`;
    thresholdSelect.append(option);
  });

  const lineSelect = $<HTMLSelectElement>('line');
  for (const line of network.lines) {
    const option = document.createElement('option');
    option.value = line;
    option.textContent = line;
    lineSelect.append(option);
  }

  let current = await loadDay('평일');
  let lineFilter: string | null = null;
  let directionMode: DirectionMode = 'both';
  /** Band index to emphasise, or null for "show every reading solid". */
  let threshold: number | null = null;
  /** Which train: the worst service running here, or a named one. */
  let serviceMode: ServiceMode = 'worst';

  const timeline = createTimeline(
    $<HTMLInputElement>('slider'),
    $('clock'),
    $<HTMLButtonElement>('play'),
    network.buckets,
  );

  const tooltip = $('tooltip');
  let hoveredIndex: number | null = null;

  /** Name the service behind a 'worst' reading, so the headline says which train. */
  function serviceLabelAt(platformIndex: number, slot: number, bucketIndex: number): string {
    const series = current.values[platformIndex]?.[slot];
    if (!series) return '';
    const present = SERVICE_SLOTS.filter((_, i) => series[i]);
    if (present.length < 2) return '';
    const a = series[0]?.[bucketIndex] ?? -1;
    const b = series[1]?.[bucketIndex] ?? -1;
    return b > a ? SERVICE_SLOTS[1] : SERVICE_SLOTS[0];
  }

  /** Does this reading pass the current threshold? */
  const matches = (pct: number | null | undefined): boolean =>
    pct !== null && pct !== undefined && (threshold === null || bandIndex(pct) >= threshold);

  /**
   * Worst reading currently on screen, and how many pass the threshold. Both
   * follow every filter — reporting a 하행 peak while the map shows 상행 would
   * describe something not drawn.
   */
  function describePeak(bucketIndex: number): string {
    let worst = -1;
    let where = '';
    let hits = 0;

    network.platforms.forEach((platform, i) => {
      if (lineFilter !== null && platform.line !== lineFilter) return;
      current.values[i]?.forEach((series, d) => {
        if (directionMode !== 'both' && d !== directionMode) return;
        const { pct, selected } = readingFor(series, bucketIndex, serviceMode);
        if (!selected || pct === null) return;
        if (matches(pct)) hits++;
        if (pct > worst) {
          worst = pct;
          const svc = serviceMode === 'worst' ? serviceLabelAt(i, d, bucketIndex) : SERVICE_SLOTS[serviceMode];
          where = `${platform.name} ${platform.line} ${platform.directions[d]?.direction ?? ''}${svc ? ' ' + svc : ''}`;
        }
      });
    });

    if (worst < 0) return 'no readings';
    const peak = `busiest now: ${where} at ${worst.toFixed(0)}%`;
    // With a threshold set, the count is the actual answer to "how bad is it
    // right now" — one worst station says nothing about how widespread it is.
    return threshold === null
      ? peak
      : `${hits} platform${hits === 1 ? '' : 's'} at ${BANDS[threshold].label}${threshold === BANDS.length - 1 ? '' : ' 이상'} · ${peak}`;
  }

  function renderTable(bucketIndex: number): void {
    const body = $('table-body');
    const rows: string[] = [];
    network.platforms.forEach((platform, i) => {
      if (lineFilter !== null && platform.line !== lineFilter) return;

      // The table is the map's twin, so it filters on the same rule — a row
      // here should mean a solid dot there.
      const shown = [0, 1].filter((d) => directionMode === 'both' || d === directionMode);
      const readingAt = (d: number) => readingFor(current.values[i]?.[d] ?? null, bucketIndex, serviceMode);
      if (threshold !== null && !shown.some((d) => matches(readingAt(d).pct))) return;

      const cells = [0, 1].map((d) => {
        const direction = platform.directions[d];
        if (!direction) return '<td class="none">—</td><td class="none">no service</td>';
        const { pct, selected } = readingAt(d);
        if (!selected) return `<td class="none">—</td><td class="none">no ${SERVICE_SLOTS[serviceMode as 0 | 1]}</td>`;
        if (pct === null) return '<td class="none">—</td><td class="none">no data</td>';
        const svc = serviceMode === 'worst' ? serviceLabelAt(i, d, bucketIndex) : SERVICE_SLOTS[serviceMode];
        return `<td class="num">${pct.toFixed(1)}%</td><td>${direction.direction} ${bandLabel(pct)}${svc ? ' · ' + svc : ''}</td>`;
      });
      rows.push(`<tr><th scope="row">${platform.name}</th><td>${platform.line}</td>${cells.join('')}</tr>`);
    });
    body.innerHTML = rows.join('');
    $('table-caption').textContent =
      `Readings at ${formatClock(network.buckets[bucketIndex])}, ${daySelect.value}` +
      (lineFilter ? ` — ${lineFilter}` : '') +
      (threshold === null ? '' : ` — ${BANDS[threshold].label} 이상만`) +
      ` (${rows.length} platforms)`;
  }

  function showTooltip(index: number, clientX: number, clientY: number): void {
    const platform = network.platforms[index];
    const bucket = timeline.index();

    // Both slots always appear, so a terminus reads as "nothing runs that way"
    // rather than silently showing one direction and leaving you to guess
    // which. DIRECTION_SLOT_LABELS names the side even when it is empty.
    const rows = platform.directions.map((direction, d) => {
      if (!direction) {
        return `<dt><span class="swatch swatch-none">✕</span></dt><dd class="pct">—</dd>` +
          `<dd class="band">${DIRECTION_SLOT_LABELS[d]} · no service</dd>`;
      }
      // Every service that runs here gets its own line. On 9호선 the 급행 and
      // the 일반 beside it differ by 70 points; one merged number would hide it.
      const series = current.values[index]?.[d] ?? null;
      const running = SERVICE_SLOTS.map((name, si) => ({ name, si })).filter(({ si }) => series?.[si]);

      return running.map(({ name, si }) => {
        const pct = series?.[si]?.[bucket] ?? null;
        const swatch = `<span class="swatch" style="background:${bandColorVar(pct)}"></span>`;
        const value = pct === null ? '—' : `${pct.toFixed(1)}%`;
        const label = pct === null ? 'no data' : bandLabel(pct);
        const svc = running.length > 1 ? ` ${name}` : '';
        return `<dt>${swatch}</dt><dd class="pct">${value}</dd>` +
          `<dd class="band">${direction.direction}${svc} → ${direction.toward} · ${label}</dd>`;
      }).join('');
    });

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
    map.paint(current.values, bucket, directionMode, threshold, serviceMode);
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

  const directionSelect = $<HTMLSelectElement>('direction');
  directionSelect.addEventListener('change', () => {
    directionMode = directionSelect.value === 'both' ? 'both' : (Number(directionSelect.value) as 0 | 1);
    renderLegend($('legend'), directionMode, threshold, serviceMode);
    repaint();
  });

  const serviceSelect = $<HTMLSelectElement>('service');
  serviceSelect.addEventListener('change', () => {
    serviceMode = serviceSelect.value === 'worst' ? 'worst' : (Number(serviceSelect.value) as 0 | 1);
    renderLegend($('legend'), directionMode, threshold, serviceMode);
    repaint();
  });

  thresholdSelect.addEventListener('change', () => {
    threshold = thresholdSelect.value === 'all' ? null : Number(thresholdSelect.value);
    renderLegend($('legend'), directionMode, threshold, serviceMode);
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

  renderLegend($('legend'), directionMode, threshold, serviceMode);

  // Start at the morning peak: it is the reason to look at this at all.
  const eightAM = network.buckets.indexOf(480);
  timeline.setIndex(eightAM >= 0 ? eightAM : 0);
  repaint();

  statusEl.textContent = '';
}

boot().catch((err) => {
  statusEl.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
});
