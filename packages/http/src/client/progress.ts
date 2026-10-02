/**
 * The progress bar of visits — plain DOM, no UI framework: every adapter shows the same one. An opt-in feature (E82): an app
 * that wants it passes `progressBar(options)` to its adapter (React: `createBespokeApp({ progress: progressBar({ delay: 250 }) })`)
 * — one that does not carries none of it, and builds its own indicator from the visit events and `aria-busy` if it likes.
 * Styled through CSS variables, set as inline style properties (no `<style>` element, so a strict
 * Content-Security-Policy does not block it):
 *
 * ```css
 * :root { --bespoke-progress-color: #e11d48; --bespoke-progress-height: 2px; }
 * ```
 */
import type { Navigator } from './navigation.ts';

export interface ProgressOptions {
  /** Milliseconds before the bar shows — fast visits never show it. Default 250. */
  delay?: number;
  /** The bar's color, unless `--bespoke-progress-color` sets one. */
  color?: string;
}

export const DEFAULT_PROGRESS_DELAY = 250;

/** The attribute on the bar's element (for styles and tests). */
export const PROGRESS_ATTRIBUTE = 'data-bespoke-progress';

/**
 * A progress indicator an adapter starts with its navigator (E82): attached to the navigator's visit events, it returns the
 * function that removes it. `progressBar(options)` is the core's; an app may pass its own.
 */
export type ProgressIndicator = (navigator: Pick<Navigator, 'on'>) => () => void;

/** The progress bar as an adapter's indicator (E82): `createBespokeApp({ progress: progressBar({ delay: 250 }) })`. */
export function progressBar(options: ProgressOptions = {}): ProgressIndicator {
  return (navigator) => showProgress(navigator, options);
}

/** Shows a progress bar while the navigator's requests run. Returns the function that removes it. */
export function showProgress(navigator: Pick<Navigator, 'on'>, { delay = DEFAULT_PROGRESS_DELAY, color = '#4f46e5' }: ProgressOptions = {}, doc: Document = document): () => void {
  let running = 0;
  let element: HTMLElement | undefined;
  /** The bar of the last visit, fading out. */
  let fading: HTMLElement | undefined;
  let value = 0;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let trickleTimer: ReturnType<typeof setInterval> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const set = (next: number) => {
    value = Math.min(Math.max(next, value), 0.994);
    if (element) element.style.transform = `scaleX(${value})`;
  };

  const show = () => {
    clearTimeout(hideTimer);
    fading?.remove();
    element = doc.createElement('div');
    element.setAttribute(PROGRESS_ATTRIBUTE, '');
    element.setAttribute('aria-hidden', 'true');
    const style = element.style;
    style.position = 'fixed';
    style.top = '0';
    style.left = '0';
    style.width = '100%';
    style.height = 'var(--bespoke-progress-height, 3px)';
    style.background = `var(--bespoke-progress-color, ${color})`;
    style.zIndex = 'var(--bespoke-progress-z-index, 2147483647)';
    style.transformOrigin = '0 0';
    style.transition = 'transform 200ms ease, opacity 300ms ease';
    style.pointerEvents = 'none';
    value = 0;
    set(0.08);
    doc.body.append(element);
    // Creeps on towards the end without ever reaching it — until the visit finishes.
    trickleTimer = setInterval(() => set(value + (0.95 - value) * 0.08), 300);
  };

  const done = () => {
    clearTimeout(showTimer);
    showTimer = undefined;
    clearInterval(trickleTimer);
    if (!element) return;
    const finished = element;
    fading = finished;
    element = undefined;
    finished.style.transform = 'scaleX(1)';
    hideTimer = setTimeout(() => {
      finished.style.opacity = '0';
      hideTimer = setTimeout(() => finished.remove(), 300);
    }, 150);
  };

  const stops = [
    // Background requests (loading deferred props) show no bar — like Inertia's async requests.
    navigator.on('start', (visit) => {
      if (visit.async) return;
      running++;
      if (running === 1 && !element && showTimer === undefined) showTimer = setTimeout(show, delay);
    }),
    navigator.on('progress', ({ percentage }, visit) => {
      if (percentage !== undefined && !visit.async) set((percentage / 100) * 0.9);
    }),
    navigator.on('finish', (visit) => {
      if (visit.async) return;
      running = Math.max(0, running - 1);
      if (running === 0) done();
    }),
  ];

  return () => {
    for (const stop of stops) stop();
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    clearInterval(trickleTimer);
    element?.remove();
    fading?.remove();
  };
}
