/**
 * Link behaviour every adapter shares: which clicks become client-side visits, and when a link prefetches.
 */

/** The parts of a click a link looks at (a DOM `MouseEvent`, or a UI framework's wrapper of one). */
export interface LinkClick {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly defaultPrevented: boolean;
}

/**
 * The URL to visit client-side for a click on a link to `href` (path, query and fragment) — or undefined when the
 * browser handles the click itself: not a plain left click (a new tab, a download), another `target`, another site,
 * or a handler prevented it.
 */
export function visitUrlOf(click: LinkClick, href: string, target: string | null | undefined, location: Pick<Location, 'href' | 'origin'> = window.location): string | undefined {
  if (click.defaultPrevented || click.button !== 0) return undefined;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return undefined;
  if (target && target !== '_self') return undefined;
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return undefined;
  return url.pathname + url.search + url.hash;
}

/** When a link fetches its page ahead: on `hover` (and when pressed — touch screens have no hover), or on `mount`. */
export type PrefetchTrigger = 'hover' | 'mount';

/** A link's `prefetch` option: `true` is `'hover'`. */
export type PrefetchSetting = boolean | PrefetchTrigger | readonly PrefetchTrigger[] | undefined;

/** How long a prefetched page is used by default: 30 s, like Inertia. */
export const DEFAULT_PREFETCH_CACHE_FOR = 30_000;

/** How long the pointer rests on a link before it prefetches (Inertia's 75 ms): passing over it does not. */
export const HOVER_PREFETCH_DELAY = 75;

const NONE: ReadonlySet<PrefetchTrigger> = new Set();

/** The triggers of a `prefetch` setting. */
export function prefetchTriggers(prefetch: PrefetchSetting): ReadonlySet<PrefetchTrigger> {
  if (prefetch === undefined || prefetch === false) return NONE;
  if (prefetch === true) return new Set(['hover']);
  return new Set(typeof prefetch === 'string' ? [prefetch] : prefetch);
}

/** The same-origin path a link prefetches (`/users/2?tab=links`) — undefined for another site, which is never prefetched. */
export function prefetchUrlOf(href: string, location: Pick<Location, 'href' | 'origin'> = window.location): string | undefined {
  const url = new URL(href, location.href);
  return url.origin === location.origin ? url.pathname + url.search : undefined;
}

/**
 * Whether a link to `href` points at the page on screen (E64) — `aria-current="page"` and `data-current`: the same URL, path and
 * query (in any order; the fragment aside) — a sort link is current for its own order only. With `activeMatch`, also when the
 * route that answered the page (`PageObject.route`) matches one of the patterns: a name (`user-profile.people` — the list,
 * whatever it is filtered by), or a prefix of names (`user-profile.*` — every route whose name starts with `user-profile.`).
 */
export function isCurrentLink(page: { readonly url: string; readonly route?: string | undefined }, href: string, activeMatch?: string | readonly string[]): boolean {
  if (activeMatch !== undefined && page.route !== undefined) {
    const patterns = typeof activeMatch === 'string' ? [activeMatch] : activeMatch;
    if (patterns.some((pattern) => matchesRouteName(pattern, page.route!))) return true;
  }
  const base = 'http://marmeon.invalid';
  let link: URL;
  let current: URL;
  try {
    link = new URL(href, new URL(page.url, base));
    current = new URL(page.url, base);
  } catch {
    return false;
  }
  if (link.origin !== current.origin || link.pathname !== current.pathname) return false;
  const query = (url: URL) => [...url.searchParams].map(([key, value]) => `${key}=${value}`).sort().join('&');
  return query(link) === query(current);
}

/** `user-profile.*` matches `user-profile.show` (and deeper), a plain name only itself, `*` every name. */
export function matchesRouteName(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}
