import type { BrowserRouteNameInput, CheckBrowserRouteName, ControllerOf, MethodOf, ParamsOf, Query } from '@bespokecore/http/page';
import { useContext, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { useRouter, type PartialReloadOptions, type VisitMethod, type VisitOptions } from './app.tsx';
import { resolveRoute, RoutesContext } from './routes.ts';

interface LinkOptions {
  replace?: boolean;
  preserveScroll?: boolean;
  preserveState?: boolean;
}

type AnchorAttributes = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;
type ButtonAttributes = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'>;

/** `<Link href="/somewhere">` — any URL, external ones included. Partial reloads (`only`) are not checked. */
type HrefLinkProps =
  | (LinkOptions & PartialReloadOptions & AnchorAttributes & { href: string; method?: 'get'; route?: never })
  | (LinkOptions &
      PartialReloadOptions &
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
  ? AnchorAttributes & { method?: 'get' }
  : ButtonAttributes & { method?: MethodOf<N> & VisitMethod; data?: VisitOptions['data'] };

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
  Omit<AnchorHTMLAttributes<HTMLAnchorElement> & ButtonAttributes, 'href' | 'onClick'> & {
    href?: string;
    route?: string;
    params?: Record<string, string | number>;
    query?: Query;
    method?: VisitMethod;
    data?: VisitOptions['data'];
    onClick?: (event: MouseEvent<HTMLAnchorElement & HTMLButtonElement>) => void;
  };

/**
 * An `<a>` that navigates client-side for same-origin, plain left clicks — and degrades to a normal link.
 *
 * ```tsx
 * <Link route="user-profile.show" params={{ user: profile.id }}>{profile.name}</Link>
 * <Link route="auth.logout">Sign out</Link>            // a POST route: a <button> sending the visit with the CSRF token
 * <Link href="https://example.com">elsewhere</Link>
 * ```
 *
 * With `route`, name, parameters and method come from `bootstrap/routes.ts`: a typo, a missing parameter or
 * `method="get"` on a POST route is a compile error. Methods other than GET render a button — actions are not links.
 */
export function Link<const N extends BrowserRouteNameInput = never>(props: LinkProps<N>) {
  const { visit } = useRouter();
  const manifest = useContext(RoutesContext);
  const { route, params, query, href: givenHref, method: givenMethod, data, replace, preserveScroll, preserveState, only, except, reset, onClick, ...rest } =
    props as AnyLinkProps;
  const options = { replace, preserveScroll, preserveState, only, except, reset };

  const target = route === undefined ? undefined : resolveRoute(manifest, route, params, query);
  const href = target?.url ?? givenHref ?? '';
  const method = (givenMethod ?? target?.method ?? 'get') as VisitMethod;

  if (method !== 'get') {
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      onClick?.(event as MouseEvent<HTMLAnchorElement & HTMLButtonElement>);
      if (event.defaultPrevented) return;
      event.preventDefault();
      void visit(href, { method, data, ...options });
    };
    return <button type="button" onClick={handleClick} {...(rest as ButtonAttributes)} />;
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

  return <a href={href} onClick={handleClick} {...(rest as AnchorAttributes)} />;
}
