/**
 * The network map.
 *
 * Built once as SVG, then only repainted: changing the time re-sets `fill` on
 * up to 554 half-discs and touches nothing else. That is what keeps the
 * timeline responsive while dragging and lets the animation run without
 * rebuilding any geometry.
 *
 * Each station is one dot split down the middle — left half is the
 * decreasing-역번호 direction (상선/외선), right half the increasing one
 * (하선/내선). The two halves peak at opposite times of day, which is the whole
 * point of showing them together.
 */
import { bandColorVar } from '../shared/scale.ts';
import type { NetworkPayload } from '../shared/types.ts';

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

export interface StationHover {
  platformIndex: number;
  clientX: number;
  clientY: number;
}

export interface MapView {
  /** Repaint every dot for one time bucket. */
  paint(values: (number | null)[][][], bucketIndex: number): void;
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
    node.setAttribute('class', 'track');
    trackLayer.append(node);
    trackEls.push({ line: segment.line, node });
  }

  // --- station dots ------------------------------------------------------
  /** halves[platformIndex][directionIndex] — the elements repainted per frame. */
  const halves: SVGPathElement[][] = [];
  const groups: SVGGElement[] = [];
  const hits: SVGCircleElement[] = [];

  network.platforms.forEach((platform, i) => {
    const [dx, dy] = fan(i);
    const group = el('g');
    group.setAttribute('transform', `translate(${px(i) + dx}, ${py(i) + dy})`);

    const sides: ('left' | 'right')[] = ['left', 'right'];
    const own: SVGPathElement[] = [];

    for (const [slot, side] of sides.entries()) {
      const path = el('path');
      path.setAttribute('d', halfDiscPath(DOT_R, side));
      if (platform.directions[slot]) {
        path.setAttribute('class', 'half');
        own.push(path);
      } else {
        // No service this way at all — 응암순환 runs one direction only. An
        // outline says "nothing runs here", which is not the same as a
        // measurement that is missing.
        path.setAttribute('class', 'half-empty');
      }
      group.append(path);
    }

    dotLayer.append(group);
    groups.push(group);
    halves.push(own);

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
  function paint(values: (number | null)[][][], bucketIndex: number): void {
    for (let i = 0; i < halves.length; i++) {
      const perDirection = values[i];
      const nodes = halves[i];
      for (let d = 0; d < nodes.length; d++) {
        const pct = perDirection?.[d]?.[bucketIndex] ?? null;
        nodes[d].setAttribute('fill', bandColorVar(pct));
      }
    }
  }

  // --- line filter -------------------------------------------------------
  function setLineFilter(line: string | null): void {
    for (const t of trackEls) {
      t.node.style.opacity = line === null || t.line === line ? '1' : '0.12';
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
