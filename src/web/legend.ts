/**
 * Legend for the ramp and for the split dot.
 *
 * Two things are encoded on every mark — magnitude by colour, direction by
 * which half of the dot it is — so neither can be left to be inferred.
 */
import { BANDS, SCALE_MAX } from '../shared/scale.ts';
import type { DirectionMode } from './map.ts';

/** How each direction slot is labelled, matching the network's sort order. */
export const DIRECTION_LABELS = ['상행 · 외선', '하행 · 내선'] as const;

export function renderLegend(container: HTMLElement, mode: DirectionMode): void {
  container.replaceChildren();

  const ramp = document.createElement('div');
  ramp.className = 'ramp';
  ramp.setAttribute('role', 'img');
  ramp.setAttribute(
    'aria-label',
    `Congestion scale: ${BANDS.map((b, i) => {
      const upper = i === BANDS.length - 1 ? `${SCALE_MAX}+` : `${BANDS[i + 1].from}`;
      return `${b.from} to ${upper} percent, ${b.label}, ${b.detail}`;
    }).join('; ')}`,
  );

  BANDS.forEach((band, i) => {
    const step = document.createElement('div');
    step.className = 'ramp-step';

    const swatch = document.createElement('div');
    swatch.className = 'ramp-swatch';
    swatch.style.background = `var(--band-${i})`;

    const label = document.createElement('span');
    label.className = 'ramp-label';
    label.textContent = band.label;

    const bound = document.createElement('span');
    bound.className = 'ramp-bound';
    bound.textContent =
      i === BANDS.length - 1 ? `${band.from}%+` : `${band.from}–${BANDS[i + 1].from - 1}%`;

    step.append(swatch, label, bound);
    step.title = band.detail;
    ramp.append(step);
  });

  const noData = document.createElement('span');
  noData.className = 'legend-key';
  noData.innerHTML =
    '<svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">' +
    '<circle cx="0" cy="0" r="6" fill="var(--no-data)" stroke="var(--dot-edge)" stroke-width="0.9"></circle>' +
    '</svg><span>no measurement</span>';

  // Direction key, drawn as the same dot the map is currently using.
  const direction = document.createElement('span');
  direction.className = 'legend-key';
  direction.innerHTML =
    mode === 'both'
      ? '<svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">' +
        '<path d="M 0,-6 A 6,6 0 0,0 0,6 Z" fill="var(--band-1)" stroke="var(--dot-edge)" stroke-width="0.9"></path>' +
        '<path d="M 0,-6 A 6,6 0 0,1 0,6 Z" fill="var(--band-3)" stroke="var(--dot-edge)" stroke-width="0.9"></path>' +
        '</svg>' +
        `<span>left half ${DIRECTION_LABELS[0]} &nbsp;/&nbsp; right half ${DIRECTION_LABELS[1]}</span>`
      : '<svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">' +
        '<circle cx="0" cy="0" r="6" fill="var(--band-3)" stroke="var(--dot-edge)" stroke-width="0.9"></circle>' +
        `</svg><span>whole dot = ${DIRECTION_LABELS[mode]}</span>`;

  const oneWay = document.createElement('span');
  oneWay.className = 'legend-key';
  oneWay.innerHTML =
    '<svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">' +
    '<circle cx="0" cy="0" r="6" fill="none" stroke="var(--dot-edge)" stroke-width="0.9" stroke-dasharray="1.8 1.8"></circle>' +
    '</svg><span>dashed = no service that way</span>';

  container.append(ramp, direction, noData, oneWay);
}
