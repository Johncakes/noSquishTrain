/**
 * The network map.
 *
 * Built once as SVG, then only repainted: changing the time re-sets `fill` on
 * the visible marks and touches nothing else. That is what keeps the timeline
 * responsive while dragging and lets the animation run without rebuilding any
 * geometry.
 *
 * In 양방향 mode each station is one dot split down the middle — left half is
 * always slot 0 (상행: 상선/외선), right half always slot 1 (하행: 하선/내선),
 * because the two peak at opposite times of day. The slots are fixed by the
 * server, so a terminus that serves only one direction still lands on the
 * correct side rather than defaulting to the left. Picking a single
 * direction fills the whole dot instead: comparing across the network is much
 * easier when the eye does not have to average two halves.
 *
 * Track carries the official line colours. That is a second colour system
 * alongside the congestion ramp, so it is deliberately thin and translucent —
 * identity for orientation, never magnitude.
 */
import { bandColorVar, bandIndex } from '../shared/scale.ts';
import type { DirectionSeries, NetworkPayload } from '../shared/types.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Width of the internal coordinate space; height follows the aspect ratio. */
const VIEW_W = 1000;
/** Station dot radius, in view units. */
const DOT_R = 4.4;
/** How far co-located platforms are pushed apart. */
const FAN_R = 3.4;
const MIN_ZOOM = 1;
const MAX_ZOOM = 14;

const el = <K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] =>
  document.createElementNS(SVG_NS, name);

/** Semicircle from top to bottom of a circle radius r, on one side. */
function halfDiscPath(r: number, side: 'left' | 'right'): string {
  const sweep = side === 'right' ? 1 : 0;
  return `M 0,${-r} A ${r},${r} 0 0,${sweep} 0,${r} Z`;
}

/**
 * An X marking a direction no train runs — a terminus, or the one-way
 * 응암순환. Structural absence, distinct from a missing measurement (grey) and
 * from a reading below the chosen threshold (dashed).
 *
 * `where` is 'full' when the whole station has no service in the current view,
 * or a half when only one direction is missing. At most one half can be
 * unserved: every platform has at least one departure, which `npm run check`
 * enforces.
 */
function crossPath(r: number, where: 'full' | 'left' | 'right'): string {
  if (where === 'full') {
    const a = r * 0.72;
    return `M ${-a},${-a} L ${a},${a} M ${-a},${a} L ${a},${-a}`;
  }
  const cx = where === 'left' ? -r * 0.44 : r * 0.44;
  const s = r * 0.38;
  return `M ${cx - s},${-s} L ${cx + s},${s} M ${cx - s},${s} L ${cx + s},${-s}`;
}

export interface StationHover {
  platformIndex: number;
  clientX: number;
  clientY: number;
}

/**
 * Which direction the dots show. 'both' splits each dot in half; a single
 * direction fills the whole dot, which is far easier to read when comparing
 * across the network.
 */
export type DirectionMode = 'both' | 0 | 1;

export interface MapView {
  /**
   * Repaint every dot for one time bucket.
   *
   * `threshold` is a band index; readings below it are drawn as a dashed
   * outline so the ones you asked about stand out against the network. Null
   * shows every reading solid.
   */
  paint(
    values: DirectionSeries[],
    bucketIndex: number,
    mode: DirectionMode,
    threshold: number | null,
  ): void;
  /** Restrict to one line, or show everything when null. */
  setLineFilter(line: string | null): void;
  onHover(handler: (hover: StationHover | null) => void): void;
  resetZoom(): void;
  zoomBy(factor: number): void;
}

export function createMap(svg: SVGSVGElement, network: NetworkPayload): MapView {
  const viewH = VIEW_W * network.aspect;
  // Pad so dots at the extremes are not clipped by the viewBox edge.
  const pad = 18;
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${VIEW_W + pad * 2} ${viewH + pad * 2}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.replaceChildren();

  const root = el('g');
  svg.append(root);

  const trackLayer = el('g');
  const dotLayer = el('g');
  const hitLayer = el('g');
  root.append(trackLayer, dotLayer, hitLayer);

  const px = (i: number) => network.platforms[i].x * VIEW_W;
  const py = (i: number) => network.platforms[i].y * viewH;

  /** Offset that separates platforms sharing one point (interchanges). */
  const fan = (i: number): [number, number] => {
    const p = network.platforms[i];
    if (p.shared < 2) return [0, 0];
    const angle = (p.slot / p.shared) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(angle) * FAN_R, Math.sin(angle) * FAN_R];
  };

  // --- track -------------------------------------------------------------
  const trackEls: { line: string; node: SVGLineElement }[] = [];
  for (const segment of network.segments) {
    const [ax, ay] = fan(segment.a);
    const [bx, by] = fan(segment.b);
    const node = el('line');
    node.setAttribute('x1', String(px(segment.a) + ax));
    node.setAttribute('y1', String(py(segment.a) + ay));
    node.setAttribute('x2', String(px(segment.b) + bx));
    node.setAttribute('y2', String(py(segment.b) + by));
    // '3호선' -> track-3, so the official line colour comes from CSS.
    node.setAttribute('class', `track track-${segment.line.replace('호선', '')}`);
    trackLayer.append(node);
    trackEls.push({ line: segment.line, node });
  }

  // --- station dots ------------------------------------------------------
  //
  // Every station carries three marks and shows either the two halves or the
  // whole circle. Two stroked half-discs would draw their shared diameter
  // twice, leaving a line down the middle of what should be one solid dot —
  // so a single direction gets a real <circle> rather than two halves painted
  // the same colour. Both are built once; switching mode only toggles display.
  const dots: {
    left: SVGPathElement;
    right: SVGPathElement;
    full: SVGCircleElement;
    cross: SVGPathElement;
  }[] = [];
  const groups: SVGGElement[] = [];
  const hits: SVGCircleElement[] = [];

  network.platforms.forEach((_platform, i) => {
    const [dx, dy] = fan(i);
    const group = el('g');
    group.setAttribute('transform', `translate(${px(i) + dx}, ${py(i) + dy})`);

    const left = el('path');
    left.setAttribute('d', halfDiscPath(DOT_R, 'left'));
    const right = el('path');
    right.setAttribute('d', halfDiscPath(DOT_R, 'right'));

    const full = el('circle');
    full.setAttribute('r', String(DOT_R));
    full.style.display = 'none';

    const cross = el('path');
    cross.setAttribute('class', 'dot-x');
    cross.style.display = 'none';

    group.append(left, right, full, cross);

    dotLayer.append(group);
    groups.push(group);
    dots.push({ left, right, full, cross });

    const hit = el('circle');
    hit.setAttribute('cx', String(px(i) + dx));
    hit.setAttribute('cy', String(py(i) + dy));
    hit.setAttribute('r', String(DOT_R * 2));
    hit.setAttribute('class', 'hit');
    hit.dataset.index = String(i);
    hitLayer.append(hit);
    hits.push(hit);
  });

  // --- painting ----------------------------------------------------------

  /**
   * Paint one mark for a direction that is actually served.
   *
   * Three outcomes, all distinct on purpose: a reading at or above the
   * threshold is solid in its band colour; a reading below it is a dashed
   * outline; a direction with no published measurement is a filled grey dot,
   * because "nobody counted" is not "quiet".
   */
  function setMark(node: SVGElement, pct: number | null, threshold: number | null): void {
    if (pct === null) {
      node.setAttribute('class', 'dot-nodata');
      node.setAttribute('fill', 'var(--no-data)');
      return;
    }
    if (threshold !== null && bandIndex(pct) < threshold) {
      node.setAttribute('class', 'dot-below');
      node.removeAttribute('fill');
      return;
    }
    node.setAttribute('class', 'dot-on');
    node.setAttribute('fill', bandColorVar(pct));
  }

  function paint(
    values: DirectionSeries[],
    bucketIndex: number,
    mode: DirectionMode,
    threshold: number | null,
  ): void {
    const both = mode === 'both';

    for (let i = 0; i < dots.length; i++) {
      const platform = network.platforms[i];
      const perDirection = values[i];
      const { left, right, full, cross } = dots[i];

      if (both) {
        full.style.display = 'none';

        for (const [slot, path] of ([left, right] as const).entries()) {
          if (!platform.directions[slot]) {
            path.style.display = 'none';
            continue;
          }
          path.style.display = '';
          setMark(path, perDirection?.[slot]?.[bucketIndex] ?? null, threshold);
        }

        // Half an X where the missing direction would have been.
        const missing = !platform.directions[0] ? 'left'
          : !platform.directions[1] ? 'right' : null;
        cross.style.display = missing ? '' : 'none';
        if (missing) cross.setAttribute('d', crossPath(DOT_R, missing));
        continue;
      }

      // One direction: one solid circle, so a station reads as a single value
      // instead of asking the eye to average two halves.
      left.style.display = 'none';
      right.style.display = 'none';

      if (!platform.directions[mode]) {
        full.style.display = 'none';
        cross.style.display = '';
        cross.setAttribute('d', crossPath(DOT_R, 'full'));
        continue;
      }

      full.style.display = '';
      cross.style.display = 'none';
      setMark(full, perDirection?.[mode]?.[bucketIndex] ?? null, threshold);
    }
  }

  // --- line filter -------------------------------------------------------
  function setLineFilter(line: string | null): void {
    for (const t of trackEls) {
      // Empty string, not '1' — the track's resting opacity is set in CSS and
      // an inline '1' would override it and make every line fully saturated.
      t.node.style.opacity = line === null || t.line === line ? '' : '0.1';
    }
    network.platforms.forEach((platform, i) => {
      const dim = line !== null && platform.line !== line;
      groups[i].style.opacity = dim ? '0.12' : '1';
      hits[i].style.pointerEvents = dim ? 'none' : '';
    });
  }

  // --- hover -------------------------------------------------------------
  let hoverHandler: (hover: StationHover | null) => void = () => {};
  const ring = el('circle');
  ring.setAttribute('class', 'station-ring');
  ring.setAttribute('r', String(DOT_R + 2.4));
  ring.style.display = 'none';
  dotLayer.append(ring);

  const showRing = (i: number) => {
    const [dx, dy] = fan(i);
    ring.setAttribute('cx', String(px(i) + dx));
    ring.setAttribute('cy', String(py(i) + dy));
    ring.style.display = '';
  };

  hitLayer.addEventListener('pointerover', (event) => {
    const target = event.target as SVGElement;
    const index = target.dataset?.index;
    if (index === undefined) return;
    showRing(Number(index));
    hoverHandler({ platformIndex: Number(index), clientX: event.clientX, clientY: event.clientY });
  });

  hitLayer.addEventListener('pointermove', (event) => {
    const target = event.target as SVGElement;
    const index = target.dataset?.index;
    if (index === undefined) return;
    hoverHandler({ platformIndex: Number(index), clientX: event.clientX, clientY: event.clientY });
  });

  hitLayer.addEventListener('pointerout', () => {
    ring.style.display = 'none';
    hoverHandler(null);
  });

  // --- pan & zoom --------------------------------------------------------
  //
  // Applied as a transform on the root group rather than by rewriting the
  // viewBox, so the dot radius and stroke widths stay put while zooming: at
  // city scale the marks must not shrink into invisibility.
  let zoom = 1;
  let panX = 0;
  let panY = 0;

  function applyTransform(): void {
    root.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
    // Counter-scale the marks so they keep their on-screen size.
    const inverse = 1 / zoom;
    for (const t of trackEls) t.node.style.strokeWidth = `${1.6 * inverse}`;
    for (const g of groups) {
      const base = g.getAttribute('transform')!.match(/translate\(([^)]+)\)/)![1];
      g.setAttribute('transform', `translate(${base}) scale(${inverse})`);
    }
    for (const h of hits) h.setAttribute('r', String(DOT_R * 2 * inverse));
    ring.setAttribute('r', String((DOT_R + 2.4) * inverse));
  }

  function zoomAt(factor: number, originX: number, originY: number): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    if (next === zoom) return;
    // Hold the point under the cursor fixed.
    panX = originX - ((originX - panX) * next) / zoom;
    panY = originY - ((originY - panY) * next) / zoom;
    zoom = next;
    applyTransform();
  }

  /** Client pixels -> view units. */
  function toView(clientX: number, clientY: number): [number, number] {
    const rect = svg.getBoundingClientRect();
    const scale = (VIEW_W + pad * 2) / rect.width;
    return [(clientX - rect.left) * scale - pad, (clientY - rect.top) * scale - pad];
  }

  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const [vx, vy] = toView(event.clientX, event.clientY);
    zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, vx, vy);
  }, { passive: false });

  let dragging: { x: number; y: number; panX: number; panY: number } | null = null;

  svg.addEventListener('pointerdown', (event) => {
    dragging = { x: event.clientX, y: event.clientY, panX, panY };
    svg.classList.add('panning');
    svg.setPointerCapture(event.pointerId);
  });

  svg.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = svg.getBoundingClientRect();
    const scale = (VIEW_W + pad * 2) / rect.width;
    panX = dragging.panX + (event.clientX - dragging.x) * scale;
    panY = dragging.panY + (event.clientY - dragging.y) * scale;
    applyTransform();
  });

  const endDrag = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = null;
    svg.classList.remove('panning');
    svg.releasePointerCapture(event.pointerId);
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  return {
    paint,
    setLineFilter,
    onHover(handler) { hoverHandler = handler; },
    resetZoom() { zoom = 1; panX = 0; panY = 0; applyTransform(); },
    zoomBy(factor) { zoomAt(factor, VIEW_W / 2, viewH / 2); },
  };
}
