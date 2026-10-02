/** `aria-busy` while a visit runs (E64) — always on in an adapter: assistive technology and CSS learn the page is about to change. */
import type { Navigator } from './navigation.ts';

/**
 * `aria-busy="true"` on `element` (the document's root) while a visit runs in the foreground (E64) — assistive technology
 * knows the page is about to change; CSS can dim it (`html[aria-busy] main { opacity: .6 }`). Background requests (deferred
 * props, polls) leave it. Returns the function that stops it.
 */
export function markBusy(navigator: Pick<Navigator, 'on'>, element: Pick<Element, 'setAttribute' | 'removeAttribute'> = document.documentElement): () => void {
  let running = 0;
  const stops = [
    navigator.on('start', (visit) => {
      if (visit.async) return;
      if (++running === 1) element.setAttribute('aria-busy', 'true');
    }),
    navigator.on('finish', (visit) => {
      if (visit.async) return;
      running = Math.max(0, running - 1);
      if (running === 0) element.removeAttribute('aria-busy');
    }),
  ];
  return () => {
    for (const stop of stops) stop();
    element.removeAttribute('aria-busy');
  };
}
