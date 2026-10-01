import type { BrowserRouteNameInput, CheckBrowserRouteName, ControllerOf, MethodOf, ParamsOf, Query } from '@bespokecore/http/page';
import { useContext, useEffect, useRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type MouseEvent, type TouchEvent } from 'react';
import { useRouter, type PartialReloadOptions, type VisitMethod, type VisitOptions } from './app.tsx';
import { resolveRoute, RoutesContext } from './routes.ts';

interface LinkOptions {
  replace?: boolean;
  preserveScroll?: boolean;
  preserveState?: boolean;
  /** Keep the URL of the page on screen ("load more" — see `VisitOptions.preserveUrl`). */
  preserveUrl?: boolean;
  /** A visit in the background: no progress bar, it cancels no other visit (see `VisitOptions.async`). */
  async?: boolean;
}

/** When a link fetches its page ahead: on `hover` (and when pressed — touch screens have no hover), or on `mount`. */
export type PrefetchTrigger = 'hover' | 'mount';

/** Prefetching — for links (GET) only. */
interface PrefetchProps {
  /**
   * Fetch the page ahead, so the click shows it at once: `true`/`'hover'` when the pointer rests on the link
   * (75 ms) or presses it, `'mount'` as soon as the link is rendered, or both. Kept in memory for `cacheFor`.
   */
  prefetch?: boolean | PrefetchTrigger | readonly PrefetchTrigger[];
  /** How long the prefetched page is used, in ms (default 30 000). */
  cacheFor?: number;
}

/** Actions (POST, DELETE, …) are never fetched ahead — the type is the message (and ignored at runtime). */
interface NoPrefetch {
  prefetch?: 'only links (GET) are prefetched — never an action (POST, PUT, PATCH, DELETE)';
  cacheFor?: never;
}

/** How long the pointer rests on a link before it prefetches (Inertia's 75 ms): passing over it does not. */
const HOVER_DELAY = 75;

type AnchorAttributes = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;
type ButtonAttributes = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'>;

/** `<Link href="/somewhere">` — any URL, external ones included. Partial reloads (`only`) are not checked. */
type HrefLinkProps =
  | (LinkOptions & PartialReloadOptions & PrefetchProps & AnchorAttributes & { href: string; method?: 'get'; route?: never })
  | (LinkOptions &
      PartialReloadOptions &
      NoPrefetch &
      ButtonAttributes & {
        href: string;
        /** Other methods render a `<button>` — actions are not links (logout, delete). */
        method: Exclude<VisitMethod, 'get'>;
        data?: VisitOptions['data'];
        route?: never;
      });

/** The path parameters of the route: required when its path has required ones. */
type ParamsProp<N extends string> = {} extends ParamsOf<N> ? { params?: ParamsOf<N> } : { params: ParamsOf<N> };

/** A GET route is a link; any other method is a `<button>` with that method — written out or left to the route. */
type MethodProps<N extends string> = [MethodOf<N>] extends ['get']
  ? AnchorAttributes & PrefetchProps & { method?: 'get' }
  : ButtonAttributes & NoPrefetch & { method?: MethodOf<N> & VisitMethod; data?: VisitOptions['data'] };

type Instance<C> = C extends abstract new (...args: never) => infer I ? I : never;

/**
 * `<Link route="user-profile.show" params={{ user: 7 }} query={{ tab: 'links' }}>` — checked against `bootstrap/routes.ts`;
 * `only`/`except` against the props of the route's page (a partial reload applies when it is the page on screen).
 */
type RouteLinkProps<N extends string> = LinkOptions &
  PartialReloadOptions<Instance<ControllerOf<N>>> & {
  route: CheckBrowserRouteName<N>;
  query?: Query;
  href?: never;
} & ParamsProp<N> &
  MethodProps<N>;

export type LinkProps<N extends string = never> = [N] extends [never] ? HrefLinkProps : RouteLinkProps<N>;

type AnyLinkProps = LinkOptions &
  PartialReloadOptions &
  PrefetchProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement> & ButtonAttributes, 'href' | 'onClick' | 'onMouseEnter' | 'onMouseLeave' | 'onMouseDown' | 'onTouchStart'> & {
    href?: string;
    route?: string;
    params?: Record<string, string | number>;
    query?: Query;
    method?: VisitMethod;
    data?: VisitOptions['data'];
    onClick?: (event: MouseEvent<HTMLAnchorElement & HTMLButtonElement>) => void;
    onMouseEnter?: (event: MouseEvent<HTMLAnchorElement & HTMLButtonElement>) => void;
    onMouseLeave?: (event: MouseEvent<HTMLAnchorElement & HTMLButtonElement>) => void;
    onMouseDown?: (event: MouseEvent<HTMLAnchorElement & HTMLButtonElement>) => void;
    onTouchStart?: (event: TouchEvent<HTMLAnchorElement & HTMLButtonElement>) => void;
  };

/**
 * An `<a>` that navigates client-side for same-origin, plain left clicks — and degrades to a normal link.
 *
 * ```tsx
 * <Link route="user-profile.show" params={{ user: profile.id }}>{profile.name}</Link>
 * <Link route="auth.logout">Sign out</Link>            // a POST route: a <button> sending the visit with the CSRF token
 * <Link href="https://example.com">elsewhere</Link>
 * <Link route="user-profile.show" params={{ user: 7 }} prefetch>Grace</Link>   // fetched on hover, shown at once on click
 * ```
 *
 * With `route`, name, parameters and method come from `bootstrap/routes.ts`: a typo, a missing parameter or
 * `method="get"` on a POST route is a compile error. Methods other than GET render a button — actions are not links
 * (and are never prefetched: `prefetch` on one is a compile error, and ignored at runtime).
 */
export function Link<const N extends BrowserRouteNameInput = never>(props: LinkProps<N>) {
  const { visit, prefetch: prefetchPage } = useRouter();
  const manifest = useContext(RoutesContext);
  const {
    route,
    params,
    query,
    href: givenHref,
    method: givenMethod,
    data,
    replace,
    preserveScroll,
    preserveState,
    preserveUrl,
    async,
    only,
    except,
    reset,
    prefetch,
    cacheFor,
    onClick,
    onMouseEnter,
    onMouseLeave,
    onMouseDown,
    onTouchStart,
    ...rest
  } = props as AnyLinkProps;
  const options = { replace, preserveScroll, preserveState, preserveUrl, async, only, except, reset };

  const target = route === undefined ? undefined : resolveRoute(manifest, route, params, query);
  const href = target?.url ?? givenHref ?? '';
  const method = (givenMethod ?? target?.method ?? 'get') as VisitMethod;

  // Prefetching: GET links to pages of this site only — and not partial reloads (they are about the page on screen).
  const triggers = method === 'get' && only === undefined && except === undefined ? prefetchTriggers(prefetch) : NONE;
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fetchAhead = () => {
    clearTimeout(hover.current);
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin) void prefetchPage(url.pathname + url.search, cacheFor === undefined ? {} : { cacheFor });
  };
  const onMount = triggers.has('mount');
  useEffect(() => {
    if (onMount) fetchAhead();
    // Prefetch again when the link goes elsewhere.
  }, [onMount, href]);
  useEffect(() => () => clearTimeout(hover.current), []);

  if (method !== 'get') {
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      onClick?.(event as MouseEvent<HTMLAnchorElement & HTMLButtonElement>);
      if (event.defaultPrevented) return;
      event.preventDefault();
      void visit(href, { method, data, ...options });
    };
    // Never prefetched — whatever `prefetch` says (an action is no page to fetch ahead).
    const handlers = { onMouseEnter, onMouseLeave, onMouseDown, onTouchStart } as Pick<ButtonAttributes, 'onMouseEnter' | 'onMouseLeave' | 'onMouseDown' | 'onTouchStart'>;
    return <button type="button" onClick={handleClick} {...handlers} {...(rest as ButtonAttributes)} />;
  }

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event as MouseEvent<HTMLAnchorElement & HTMLButtonElement>);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (rest.target && rest.target !== '_self') return;

    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return;

    event.preventDefault();
    void visit(url.pathname + url.search + url.hash, options);
  };

  const onHover = triggers.has('hover');
  const as = (event: MouseEvent<HTMLAnchorElement>) => event as MouseEvent<HTMLAnchorElement & HTMLButtonElement>;
  return (
    <a
      href={href}
      onClick={handleClick}
      onMouseEnter={(event) => {
        onMouseEnter?.(as(event));
        if (onHover) hover.current = setTimeout(fetchAhead, HOVER_DELAY);
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(as(event));
        clearTimeout(hover.current);
      }}
      onMouseDown={(event) => {
        onMouseDown?.(as(event));
        if (onHover && event.button === 0) fetchAhead();
      }}
      onTouchStart={(event) => {
        onTouchStart?.(event as TouchEvent<HTMLAnchorElement & HTMLButtonElement>);
        if (onHover) fetchAhead();
      }}
      {...(rest as AnchorAttributes)}
    />
  );
}

const NONE: ReadonlySet<PrefetchTrigger> = new Set();

function prefetchTriggers(prefetch: PrefetchProps['prefetch']): ReadonlySet<PrefetchTrigger> {
  if (prefetch === undefined || prefetch === false) return NONE;
  if (prefetch === true) return new Set(['hover']);
  return new Set(typeof prefetch === 'string' ? [prefetch] : prefetch);
}
