/**
 * The time control: a scrubber over the 39 published buckets, plus playback.
 *
 * Playback steps buckets on a timer rather than interpolating — the data is
 * half-hourly, and easing between buckets would draw values that were never
 * measured.
 */
import { formatClock } from '../shared/scale.ts';

/** Milliseconds per bucket during playback: 39 buckets ≈ 6s for a full day. */
const FRAME_MS = 160;

export interface Timeline {
  index(): number;
  setIndex(next: number): void;
  onChange(handler: (index: number) => void): void;
  toggle(): void;
  stop(): void;
}

export function createTimeline(
  slider: HTMLInputElement,
  clock: HTMLElement,
  playButton: HTMLButtonElement,
  buckets: readonly number[],
): Timeline {
  let current = 0;
  let timer: number | null = null;
  let handler: (index: number) => void = () => {};

  slider.min = '0';
  slider.max = String(buckets.length - 1);
  slider.step = '1';

  function render(): void {
    slider.value = String(current);
    clock.textContent = formatClock(buckets[current]);
    slider.setAttribute('aria-valuetext', formatClock(buckets[current]));
    handler(current);
  }

  function setIndex(next: number): void {
    const clamped = Math.min(buckets.length - 1, Math.max(0, next));
    if (clamped === current) return;
    current = clamped;
    render();
  }

  function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
    playButton.setAttribute('aria-pressed', 'false');
    playButton.textContent = '▶';
    playButton.setAttribute('aria-label', 'Play through the day');
  }

  function start(): void {
    // Restarting from the end would otherwise stall on the last frame.
    if (current >= buckets.length - 1) setIndex(0);
    playButton.setAttribute('aria-pressed', 'true');
    playButton.textContent = '❚❚';
    playButton.setAttribute('aria-label', 'Pause');
    timer = window.setInterval(() => {
      if (current >= buckets.length - 1) setIndex(0);
      else setIndex(current + 1);
    }, FRAME_MS);
  }

  function toggle(): void {
    if (timer === null) start();
    else stop();
  }

  slider.addEventListener('input', () => {
    stop(); // Grabbing the scrubber means taking manual control.
    setIndex(Number(slider.value));
  });

  playButton.addEventListener('click', toggle);

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement && event.target !== slider) return;
    if (event.target instanceof HTMLSelectElement) return;
    if (event.key === ' ') { event.preventDefault(); toggle(); }
    else if (event.key === 'ArrowRight') { stop(); setIndex(current + 1); }
    else if (event.key === 'ArrowLeft') { stop(); setIndex(current - 1); }
  });

  render();

  return {
    index: () => current,
    setIndex,
    onChange(next) { handler = next; render(); },
    toggle,
    stop,
  };
}
