import {
  HOVER_PREFETCH_DELAY,
  isCurrentLink,
  linkQuery,
  prefetchTriggers,
  prefetchUrlOf,
  resolveRoute,
  visitUrlOf,
  type Confirm,
  type PrefetchTrigger,
  type VisitMethod,
  type VisitOptions,
} from '@bespokecore/http/client';
import type { BrowserRouteName, BrowserRouteNameInput, CheckLayerRouteName, CheckPageRouteName, ControllerOf, MethodOf, ParamsOf, Query, QueryParams } from '@bespokecore/http/page';
import { useContext, useEffect, useRef, useSyncExternalStore, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type MouseEvent, type TouchEvent } from 'react';
import { usePage, useRouter, useRouterContext, type PartialReloadOptions } from './app.tsx';
import { RoutesContext } from './routes.ts';

export type { PrefetchTrigger } from '@bespokecore/http/client';

interface LinkOptions {
  replace?: boolean;
  preserveScroll?: boolean;
  preserveState?: boolean;
  /** Keep the URL of the page on screen ("load more" — see `VisitOptions.preserveUrl`). */
  preserveUrl?: boolean;
  /** A visit in the background: no progress bar, it cancels no other visit (see `VisitOptions.async`). */
  async?: boolean;
  /**
   * Ask first (E64): `confirm="Remove this link?"`, or with a title, labels or a text to type —
   * `confirm={{ message: 'Delete the project?', prompt: 'DELETE' }}`. A no sends nothing.
   */
  confirm?: Confirm;
}

/** `user-profile.*` for every name `user-profile.…` (and deeper prefixes) — the patterns of `activeMatch`. */
type NamePrefixes<N extends string> = N extends `${infer Head}.${infer Tail}` ? `${Head}.*` | `${Head}.${NamePrefixes<Tail>}` : never;

/** What `activeMatch` takes: a route name the browser knows, a prefix of names (`user-profile.*`), or `*`. */
export type ActiveMatch = '*' | BrowserRouteName | NamePrefixes<BrowserRouteName>;

/** Marking the link to the page on screen (E64). */
interface CurrentProps {
  /**
   * The link is current (`aria-current="page"`, `data-current`) for its own URL — and, with this, for every page whose route
   * matches: `activeMatch="user-profile.*"` (a section of the menu), a name, or several. Checked against the app's routes.
   */
  activeMatch?: ActiveMatch | readonly ActiveMatch[];
}

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

type AnchorAttributes = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;
type ButtonAttributes = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'>;

/** `<Link href="/somewhere">` — any URL, external ones included. Partial reloads (`only`) are not checked. */
type HrefLinkProps =
  | (LinkOptions & PartialReloadOptions & PrefetchProps & CurrentProps & AnchorAttributes & { href: string; method?: 'get'; route?: never })
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
  ? AnchorAttributes & PrefetchProps & CurrentProps & { method?: 'get' }
  : ButtonAttributes & NoPrefetch & { method?: MethodOf<N> & VisitMethod; data?: VisitOptions['data'] };

type Instance<C> = C extends abstract new (...args: never) => infer I ? I : never;

/**
 * `<Link route="user-profile.show" params={{ user: 7 }} query={{ tab: 'links' }}>` — checked against `bootstrap/routes.ts`;
 * `only`/`except` against the props of the route's page (a partial reload applies when it is the page on screen).
 */
type RouteLinkProps<N extends string> = LinkOptions &
  PartialReloadOptions<Instance<ControllerOf<N>>> & {
  /** A page or an action — an island route is a compile error (embed it with `<Island route>`). */
  route: CheckPageRouteName<N>;
  /**
   * The query, typed by the route's query schema (E55) — a wrong key or value is a compile error. For the page on
   * screen, fields that are just its defaults are left out of the URL.
   */
  query?: QueryParams<N>;
  /**
   * Open it as a layer over the page on screen (E53) — a modal, a slide-over, with a history entry of its own (Back closes
   * it). Only for routes whose controller answers `this.view(…).layer({ base })`; anything else is a compile error.
   */
  layer?: CheckLayerRouteName<N> extends N ? boolean : CheckLayerRouteName<N>;
  href?: never;
} & ParamsProp<N> &
  MethodProps<N>;

export type LinkProps<N extends string = never> = [N] extends [never] ? HrefLinkProps : RouteLinkProps<N>;

type AnyLinkProps = LinkOptions &
  PartialReloadOptions &
  PrefetchProps &
  CurrentProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement> & ButtonAttributes, 'href' | 'onClick' | 'onMouseEnter' | 'onMouseLeave' | 'onMouseDown' | 'onTouchStart'> & {
    href?: string;
    route?: string;
    params?: Record<string, string | number>;
    query?: Query;
    method?: VisitMethod;
    data?: VisitOptions['data'];
    layer?: boolean;
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
 * <Link route="user-profile.edit" params={{ user: 7 }} layer>Edit</Link>     // a layer (modal) over the page on screen
 * ```
 *
 * With `route`, name, parameters and method come from `bootstrap/routes.ts`: a typo, a missing parameter or
 * `method="get"` on a POST route is a compile error. Methods other than GET render a button — actions are not links
 * (and are never prefetched: `prefetch` on one is a compile error, and ignored at runtime).
 */
export function Link<const N extends BrowserRouteNameInput = never>(props: LinkProps<N>) {
  const { visit, prefetch: prefetchPage } = useRouter();
  const navigator = useRouterContext().navigator();
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
    layer,
    confirm,
    activeMatch,
    onClick,
    onMouseEnter,
    onMouseLeave,
    onMouseDown,
    onTouchStart,
    ...rest
  } = props as AnyLinkProps;
  const options = {
    replace,
    preserveScroll,
    preserveState,
    preserveUrl,
    async,
    only,
    except,
    reset,
    ...(layer ? { layer: true } : {}),
    ...(confirm !== undefined ? { confirm } : {}),
    // The route's name goes with the visit: `usePending(name)` (E64).
    ...(route !== undefined ? { name: route } : {}),
  };

  const page = usePage();
  const target =
    route === undefined
      ? undefined
      : resolveRoute(manifest, route, params, query && linkQuery(page, resolveRoute(manifest, route, params).url, query));
  const href = target?.url ?? givenHref ?? '';
  const method = (givenMethod ?? target?.method ?? 'get') as VisitMethod;
  // Its visit is under way (E64): `data-pending` — whichever component started a visit of the same URL and method.
  const visiting = useSyncExternalStore(navigator ? (listener) => navigator.subscribeVisiting(listener) : noSubscription, () => navigator?.visiting, () => undefined);
  const pending = visiting !== undefined && !visiting.async && visiting.method === method && visiting.url === withoutHash(href) ? { 'data-pending': '' } : {};

  // Prefetching: GET links to pages of this site only — and not partial reloads (they are about the page on screen).
  const triggers = method === 'get' && only === undefined && except === undefined ? prefetchTriggers(prefetch) : prefetchTriggers(false);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fetchAhead = () => {
    clearTimeout(hover.current);
    const url = prefetchUrlOf(href);
    if (url !== undefined) void prefetchPage(url, { ...(cacheFor === undefined ? {} : { cacheFor }), ...(layer ? { layer: true } : {}) });
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
    return <button type="button" onClick={handleClick} {...pending} {...handlers} {...(rest as ButtonAttributes)} />;
  }

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event as MouseEvent<HTMLAnchorElement & HTMLButtonElement>);
    // Plain left clicks on links to this site only — the browser handles the rest (new tabs, other sites).
    const url = visitUrlOf(event, href, rest.target);
    if (url === undefined) return;
    event.preventDefault();
    void visit(url, options);
  };

  const onHover = triggers.has('hover');
  const as = (event: MouseEvent<HTMLAnchorElement>) => event as MouseEvent<HTMLAnchorElement & HTMLButtonElement>;
  // The page on screen (E64): `aria-current="page"` for assistive technology, `data-current` for styles — the app's own wins.
  const current = isCurrentLink(page, href, activeMatch) ? { 'aria-current': 'page' as const, 'data-current': '' } : {};
  return (
    <a
      href={href}
      {...current}
      {...pending}
      onClick={handleClick}
      onMouseEnter={(event) => {
        onMouseEnter?.(as(event));
        if (onHover) hover.current = setTimeout(fetchAhead, HOVER_PREFETCH_DELAY);
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

const noSubscription = () => () => {};

/** Path and query — what a visit's URL is. */
function withoutHash(href: string): string {
  const index = href.indexOf('#');
  return index < 0 ? href : href.slice(0, index);
}
