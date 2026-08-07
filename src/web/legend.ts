/**
 * Legend for the ramp and for the split dot.
 *
 * Two things are encoded on every mark — magnitude by colour, direction by
 * which half of the dot it is — so neither can be left to be inferred.
 */
import { BANDS, SCALE_MAX } from '../shared/scale.ts';

export function renderLegend(container: HTMLElement): void {
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
    '<svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="var(--no-data)"></circle></svg>' +
    '<span>no measurement</span>';

  // Direction key, drawn as the same split dot the map uses.
  const split = document.createElement('span');
  split.className = 'legend-key';
  split.innerHTML =
    '<svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">' +
    '<path d="M 0,-6 A 6,6 0 0,0 0,6 Z" fill="var(--band-1)"></path>' +
    '<path d="M 0,-6 A 6,6 0 0,1 0,6 Z" fill="var(--band-3)"></path>' +
    '</svg>' +
    '<span>left half 상선·외선 &nbsp;/&nbsp; right half 하선·내선</span>';

  const oneWay = document.createElement('span');
  oneWay.className = 'legend-key';
  oneWay.innerHTML =
    '<svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">' +
    '<path d="M 0,-6 A 6,6 0 0,0 0,6 Z" fill="none" stroke="var(--track)" stroke-width="1.2"></path>' +
    '<path d="M 0,-6 A 6,6 0 0,1 0,6 Z" fill="var(--band-2)"></path>' +
    '</svg>' +
    '<span>outline = no service that way</span>';

  container.append(ramp, split, noData, oneWay);
}
