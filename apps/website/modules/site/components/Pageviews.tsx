import { usePage, type LayoutProps } from '@marmeon/react';
import { useEffect, type ComponentType } from 'react';
import { FATHOM_SCRIPT } from '../fathom.ts';

declare global {
  interface Window {
    /** Fathom Analytics' API, once its script has loaded (only where the document carries it). */
    fathom?: { trackPageview(options?: { url?: string; referrer?: string }): void };
  }
}

/** The page a URL stands for: its path. Neither the query (the docs search keeps its terms there) nor the hash tells pages apart. */
export function pageOf(url: string): string {
  return url.replace(/[?#].*$/s, '');
}

/** The address Fathom is told: the page on this origin, without a query. */
export function absolute(page: string, origin: string): string {
  return new URL(pageOf(page), origin).href;
}

/**
 * Reports the page the first time and each time the visitor lands on another one (`previous` is undefined the first time). Fathom's
 * script counts nothing itself (`data-auto="false"`) and its `data-spa` mode could not see these changes: the router commits them
 * through the Navigation API, which calls neither `pushState` nor `replaceState`.
 */
export function createPageviewCounter(track: (page: string, previous: string | undefined) => void): (url: string) => void {
  let last: string | undefined;
  return (url) => {
    const page = pageOf(url);
    const before = last;
    last = page;
    if (before !== page) track(page, before);
  };
}

/**
 * The query keys this site puts user input in. Fathom's script reads the address bar itself and forwards `keyword`, `q`, `ref`, `s`,
 * `utm_*`, `action`, `name`, `pagename`, `tab`, `via`, `gclid` and `msclkid` with every pageview, whatever URL it is given: a page
 * whose address has one of the site's keys is not sent. A new page that takes user input in one of Fathom's other keys must be added.
 */
export const FATHOM_QUERY_KEYS: readonly string[] = ['q'];

/**
 * What to do with a page now: `send` it, `wait` (Fathom's script has not loaded, or the address bar still shows another page —
 * the effect can run before the browser has committed the visit), or `skip` it for good (its address carries user input).
 */
export function decide(page: string, address: { pathname: string; search: string }, loaded: boolean): 'send' | 'skip' | 'wait' {
  if (!loaded || address.pathname !== pageOf(page)) return 'wait';
  const query = new URLSearchParams(address.search); // decodes the keys: `?%71=x` is `q`
  return FATHOM_QUERY_KEYS.some((key) => query.has(key)) ? 'skip' : 'send';
}

function send(page: string, previous: string | undefined, tries = 40): void {
  const tag = document.querySelector(`script[src="${FATHOM_SCRIPT}"]`);
  if (!window.fathom && !tag) return; // no Fathom in this document (development, test, no site id)
  const fathom = window.fathom;
  // A blocked or failed script never fires `load`: nothing is sent, nothing thrown.
  if (!fathom) return tag?.addEventListener('load', () => send(page, previous, tries), { once: true });
  const verdict = decide(page, location, true);
  if (verdict === 'send') {
    fathom.trackPageview({ url: absolute(page, location.origin), ...(previous === undefined ? {} : { referrer: absolute(previous, location.origin) }) });
  } else if (verdict === 'wait' && tries > 0) setTimeout(() => send(page, previous, tries - 1), 50);
}

// Module level: a switch between the site and the docs layout remounts the tracker, but not the tab's history.
const counter = createPageviewCounter(send);

/**
 * Watches `usePage().url`, which every committed visit changes: a link, Back and Forward (from memory or fetched) and both history
 * paths alike. Partial reloads, deferred props and prefetches leave the path as it is. A no-op without Fathom's script.
 *
 * A layer (the search above a page) does not change the layout's `usePage().url`: opening it counts nothing, and while its address
 * is in the bar `decide()` waits, so the search terms never reach Fathom.
 */
function Pageviews() {
  const { url } = usePage();
  useEffect(() => counter(url), [url]);
  return null;
}

/** The layout with the page counter beside it. */
export function withPageviews(Layout: ComponentType<LayoutProps>): ComponentType<LayoutProps> {
  return function Counted(props: LayoutProps) {
    return (
      <>
        <Pageviews />
        <Layout {...props} />
      </>
    );
  };
}
