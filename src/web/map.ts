/**
 * The network map.
 *
 * Built once as SVG, then only repainted: changing the time re-sets `fill` on
 * the visible marks and touches nothing else. That is what keeps the timeline
 * responsive while dragging and lets the animation run without rebuilding any
 * geometry.
 *
 * Geometry lives in viewBox units, but every MARK is sized in screen pixels.
 * The viewBox fits the whole network into the container, so its scale falls as
 * the window shrinks — at 340x260 the fit is 0.315, which rendered a 4.4-unit
 * dot at 1.4px and made the map unusable on a phone. applyTransform() divides
 * that fit back out, so a dot is DOT_PX across at every window size and zoom.
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
import type { DirectionSeries, NetworkPayload, ServiceSeries } from '../shared/types.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Width of the internal coordinate space; height follows the aspect ratio. */
const VIEW_W = 1000;
/** Station dot radius, in view units — the size the marks are DRAWN at. */
const DOT_R = 4.4;
/** How far co-located platforms are pushed apart, in view units. */
const FAN_R = 3.4;

/**
 * On-screen sizes, in CSS pixels. These are what the reader actually gets:
 * the marks are drawn at the view-unit sizes above and then counter-scaled to
 * land on these, so they hold steady from a phone to a wall display.
 */
const DOT_PX = 5;
const TRACK_PX = 1.7;
/** Municipal boundaries: a hairline, so they never read as a route. */
const BOUNDARY_PX = 0.75;
/** Touch targets need to clear a fingertip, not just the dot. */
const HIT_PX = 13;

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

/**
 * Which train's numbers to show. 'worst' takes the higher of the services a
 * platform runs, which is the honest answer to "how squished might I be here";
 * picking one names a specific train. 급행 runs on 9호선 only, so selecting it
 * dims everything else rather than pretending those platforms have one.
 */
export type ServiceMode = 'worst' | 0 | 1;

/** The reading to draw for one direction, given the service selection. */
export function readingFor(
  series: ServiceSeries | null,
  bucketIndex: number,
  mode: ServiceMode,
): { pct: number | null; selected: boolean } {
  if (!series) return { pct: null, selected: false };

  if (mode !== 'worst') {
    const chosen = series[mode];
    // The platform does not run this train at all — not the same as running it
    // empty, so it is de-emphasised rather than drawn as a low reading.
    if (!chosen) return { pct: null, selected: false };
    return { pct: chosen[bucketIndex] ?? null, selected: true };
  }

  let worst: number | null = null;
  for (const s of series) {
    const pct = s?.[bucketIndex];
    if (pct === null || pct === undefined) continue;
    if (worst === null || pct > worst) worst = pct;
  }
  return { pct: worst, selected: true };
}

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
    service: ServiceMode,
  ): void;
  /** Restrict to one line, or show everything when null. */
  setLineFilter(line: string | null): void;
  onHover(handler: (hover: StationHover | null) => void): void;
  resetZoom(): void;
  zoomBy(factor: number): void;
  /** Stop observing the container. */
  destroy(): void;
}

export function createMap(svg: SVGSVGElement, network: NetworkPayload): MapView {
  const viewH = VIEW_W * network.aspect;
  // Pad so dots at the extremes are not clipped by the viewBox edge.
  const pad = 18;
  const vbW = VIEW_W + pad * 2;
  const vbH = viewH + pad * 2;
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${vbW} ${vbH}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.replaceChildren();

  const root = el('g');
  svg.append(root);

  const baseLayer = el('g');
  const trackLayer = el('g');
  const dotLayer = el('g');
  root.append(baseLayer, trackLayer, dotLayer);

  const px = (i: number) => network.platforms[i].x * VIEW_W;
  const py = (i: number) => network.platforms[i].y * viewH;

  // --- backdrop ----------------------------------------------------------
  //
  // Water and municipal boundaries, already projected by the server into the
  // same 0..1 space as the platforms, so they need only the same scaling.
  // Drawn first and never touched again: it is reference geometry, and the
  // eye should find it only when looking for it.
  const basePaths: SVGPathElement[] = [];
  for (const shape of network.basemap ?? []) {
    if (shape.points.length < 2) continue;
    const d = shape.points
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${(x * VIEW_W).toFixed(2)},${(y * viewH).toFixed(2)}`)
      .join(' ');
    const node = el('path');
    // Water closes so it can be filled; a boundary is an open run clipped to
    // the view, and closing it would draw a chord straight across the map.
    node.setAttribute('d', shape.kind === 'water' ? `${d} Z` : d);
    node.setAttribute('class', shape.kind === 'water' ? 'water' : 'district');
    baseLayer.append(node);
    basePaths.push(node);
  }

  /**
   * Offset separating platforms that share one point (interchanges), in view
   * units relative to the dot. It rides INSIDE the mark transform rather than
   * in the station's position, so it shrinks and grows with the dots — held in
   * view units it would stay put while the dots grew and 왕십리's four
   * platforms would collapse into one blob.
   */
  const fan = (i: number): [number, number] => {
    const p = network.platforms[i];
    if (p.shared < 2) return [0, 0];
    const angle = (p.slot / p.shared) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(angle) * FAN_R, Math.sin(angle) * FAN_R];
  };

  /**
   * CSS pixels per view unit, as the browser currently renders the viewBox,
   * plus the letterbox offset that 'meet' leaves on the slack axis.
   *
   * With preserveAspectRatio="meet" the whole viewBox is fitted, so the
   * SMALLER ratio wins and the other axis is centred. The network is 0.79 as
   * tall as it is wide, so in any container wider than that the binding
   * constraint is height and there is real slack on x — assuming the width
   * ratio (as this once did) put the cursor in the wrong place and made
   * zoom-to-cursor drift.
   */
  function fit(): { scale: number; offX: number; offY: number; rect: DOMRect } {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { scale: 1, offX: 0, offY: 0, rect };
    const scale = Math.min(rect.width / vbW, rect.height / vbH);
    return {
      scale,
      offX: (rect.width - vbW * scale) / 2,
      offY: (rect.height - vbH * scale) / 2,
      rect,
    };
  }

  /** Client pixels -> view units. */
  function toView(clientX: number, clientY: number): [number, number] {
    const { scale, offX, offY, rect } = fit();
    return [
      (clientX - rect.left - offX) / scale - pad,
      (clientY - rect.top - offY) / scale - pad,
    ];
  }

  // --- track -------------------------------------------------------------
  //
  // Endpoints are the station's own position, without the interchange fan.
  // The fan is now a screen-pixel offset on the mark, so folding it into the
  // track would make the line ends drift against the dots as the window
  // resized. A segment that stops at the centre of a fanned cluster reads
  // correctly anyway.
  const trackEls: { line: string; node: SVGLineElement }[] = [];
  for (const segment of network.segments) {
    const node = el('line');
    node.setAttribute('x1', String(px(segment.a)));
    node.setAttribute('y1', String(py(segment.a)));
    node.setAttribute('x2', String(px(segment.b)));
    node.setAttribute('y2', String(py(segment.b)));
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
  //
  // The hit target lives in the group too, so it inherits the same scale and
  // stays a fingertip wide at every zoom. Dots are pointer-events:none in CSS,
  // so only these transparent circles ever receive a pointer.
  const dots: {
    left: SVGPathElement;
    right: SVGPathElement;
    full: SVGCircleElement;
    cross: SVGPathElement;
  }[] = [];
  const groups: SVGGElement[] = [];
  const hits: SVGCircleElement[] = [];
  /** Station position and interchange fan, kept so transforms are rebuilt, not re-parsed. */
  const anchors: { x: number; y: number; fx: number; fy: number }[] = [];

  network.platforms.forEach((_platform, i) => {
    const [fx, fy] = fan(i);
    anchors.push({ x: px(i), y: py(i), fx, fy });

    const group = el('g');

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

    const hit = el('circle');
    hit.setAttribute('r', String(DOT_R * (HIT_PX / DOT_PX)));
    hit.setAttribute('class', 'hit');
    hit.dataset.index = String(i);

    group.append(left, right, full, cross, hit);
    dotLayer.append(group);

    groups.push(group);
    dots.push({ left, right, full, cross });
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
  function setMark(
    node: SVGElement,
    reading: { pct: number | null; selected: boolean },
    threshold: number | null,
  ): void {
    // Not the train you asked about: a station, but not part of this question.
    if (!reading.selected) {
      node.setAttribute('class', 'dot-below');
      node.removeAttribute('fill');
      return;
    }
    if (reading.pct === null) {
      node.setAttribute('class', 'dot-nodata');
      node.setAttribute('fill', 'var(--no-data)');
      return;
    }
    if (threshold !== null && bandIndex(reading.pct) < threshold) {
      node.setAttribute('class', 'dot-below');
      node.removeAttribute('fill');
      return;
    }
    node.setAttribute('class', 'dot-on');
    node.setAttribute('fill', bandColorVar(reading.pct));
  }

  function paint(
    values: DirectionSeries[],
    bucketIndex: number,
    mode: DirectionMode,
    threshold: number | null,
    service: ServiceMode,
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
          setMark(path, readingFor(perDirection?.[slot] ?? null, bucketIndex, service), threshold);
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
      setMark(full, readingFor(perDirection?.[mode] ?? null, bucketIndex, service), threshold);
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
  let ringIndex: number | null = null;

  const showRing = (i: number) => {
    ringIndex = i;
    ring.setAttribute('transform', markTransform(i));
    ring.style.display = '';
  };

  dotLayer.addEventListener('pointerover', (event) => {
    const target = event.target as SVGElement;
    const index = target.dataset?.index;
    if (index === undefined) return;
    showRing(Number(index));
    hoverHandler({ platformIndex: Number(index), clientX: event.clientX, clientY: event.clientY });
  });

  dotLayer.addEventListener('pointermove', (event) => {
    const target = event.target as SVGElement;
    const index = target.dataset?.index;
    if (index === undefined) return;
    hoverHandler({ platformIndex: Number(index), clientX: event.clientX, clientY: event.clientY });
  });

  dotLayer.addEventListener('pointerout', () => {
    ring.style.display = 'none';
    ringIndex = null;
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

  /**
   * Place one station's marks: move to its position, then undo the viewBox fit
   * and the zoom so the dot is DOT_PX wide, then apply the interchange fan
   * inside that scaled space.
   */
  function markTransform(i: number): string {
    const a = anchors[i];
    const s = markScale();
    return `translate(${a.x} ${a.y}) scale(${s}) translate(${a.fx} ${a.fy})`;
  }

  /** View units per CSS pixel at the current fit and zoom. */
  function perPx(): number {
    return 1 / (fit().scale * zoom);
  }

  function markScale(): number {
    return (DOT_PX / DOT_R) * perPx();
  }

  function applyTransform(): void {
    root.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
    const unit = perPx();
    for (const t of trackEls) t.node.style.strokeWidth = `${TRACK_PX * unit}`;
    for (const p of basePaths) p.style.strokeWidth = `${BOUNDARY_PX * unit}`;
    for (let i = 0; i < groups.length; i++) groups[i].setAttribute('transform', markTransform(i));
    // The ring is not inside a station group, so it needs the same transform.
    // Its stroke needs no help: inside that scaled space one view unit is a
    // fixed DOT_PX/DOT_R pixels, so the CSS width already renders constant.
    if (ringIndex !== null) ring.setAttribute('transform', markTransform(ringIndex));
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

  /**
   * Can the page itself scroll right now?
   *
   * A map that swallows the wheel is fine when it owns the whole viewport, and
   * a trap when the page has content below it — which is exactly the narrow
   * window where the reader most needs to scroll. So plain wheel zooms only
   * when there is nothing to scroll past; ctrl/⌘+wheel (what a trackpad pinch
   * sends) always zooms.
   */
  function pageCanScroll(): boolean {
    for (let node: Element | null = svg; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 1) return true;
    }
    const doc = document.scrollingElement;
    return !!doc && doc.scrollHeight > doc.clientHeight + 1;
  }

  svg.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey && pageCanScroll()) return;
    event.preventDefault();
    const [vx, vy] = toView(event.clientX, event.clientY);
    zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, vx, vy);
  }, { passive: false });

  // Mouse and pen drag to pan. Touch is deliberately excluded: with
  // touch-action:pan-y the browser scrolls the page on a one-finger swipe,
  // which is what a reader expects from a page, and two fingers pan the map.
  let dragging: { x: number; y: number; panX: number; panY: number } | null = null;

  svg.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch') return trackTouch(event);
    dragging = { x: event.clientX, y: event.clientY, panX, panY };
    svg.classList.add('panning');
    svg.setPointerCapture(event.pointerId);
  });

  svg.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return moveTouch(event);
    if (!dragging) return;
    const unit = 1 / fit().scale;
    panX = dragging.panX + (event.clientX - dragging.x) * unit;
    panY = dragging.panY + (event.clientY - dragging.y) * unit;
    applyTransform();
  });

  const endDrag = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return dropTouch(event);
    if (!dragging) return;
    dragging = null;
    svg.classList.remove('panning');
    svg.releasePointerCapture(event.pointerId);
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  // --- two-finger pan and pinch ------------------------------------------
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; cx: number; cy: number } | null = null;

  /** Centroid and separation of the two active touches, in view units. */
  function pinchState(): { dist: number; cx: number; cy: number } | null {
    const pts = [...touches.values()];
    if (pts.length < 2) return null;
    const [a, b] = pts;
    const [ax, ay] = toView(a.x, a.y);
    const [bx, by] = toView(b.x, b.y);
    return {
      dist: Math.hypot(bx - ax, by - ay),
      cx: (ax + bx) / 2,
      cy: (ay + by) / 2,
    };
  }

  function trackTouch(event: PointerEvent): void {
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pinch = pinchState();
  }

  function moveTouch(event: PointerEvent): void {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const next = pinchState();
    if (!pinch || !next) return;
    event.preventDefault();
    // Pan by how far the pair's centre moved, zoom by how far it spread.
    panX += next.cx - pinch.cx;
    panY += next.cy - pinch.cy;
    applyTransform();
    if (pinch.dist > 0 && next.dist > 0) zoomAt(next.dist / pinch.dist, next.cx, next.cy);
    pinch = pinchState();
  }

  function dropTouch(event: PointerEvent): void {
    touches.delete(event.pointerId);
    pinch = pinchState();
  }

  // The container drives the mark size, so a resize has to redo the transforms.
  // This also delivers the first sizing: at construction the map may still be
  // display:none or zero-width, and reading getBoundingClientRect() then would
  // bake in a bogus scale.
  const observer = new ResizeObserver(() => applyTransform());
  observer.observe(svg);

  applyTransform();

  return {
    paint,
    setLineFilter,
    onHover(handler) { hoverHandler = handler; },
    resetZoom() { zoom = 1; panX = 0; panY = 0; applyTransform(); },
    zoomBy(factor) { zoomAt(factor, VIEW_W / 2, viewH / 2); },
    destroy() { observer.disconnect(); },
  };
}
