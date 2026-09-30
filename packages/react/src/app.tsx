import { isPageObject, LOCATION_HEADER, PAGE_HEADER, VERSION_HEADER, type PageObject, type SharedProps } from '@bespokecore/http/page';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PageComponent, ResolvePage } from './pages.ts';

export type VisitMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface VisitOptions {
  /** Default `get`. Other methods send `data` and the CSRF token (`X-XSRF-TOKEN`). */
  method?: VisitMethod;
  /** Sent as JSON — or as multipart when it is a `FormData` (file uploads). For `get`, as query string. */
  data?: Record<string, unknown> | FormData;
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Keep the scroll position (default: scroll to the top on a new page). */
  preserveScroll?: boolean;
  /**
   * Keep component state (form input, open panels) when the same page component
   * comes back. Default: true for non-GET visits — a form that failed validation
   * keeps what was typed — false for GET visits.
   */
  preserveState?: boolean;
  headers?: Record<string, string>;
}

interface RouterValue {
  page: PageObject;
  /** Resolves with the page the visit ended on (undefined if the browser took over). */
  visit: (url: string, options?: VisitOptions) => Promise<PageObject | undefined>;
}

const RouterContext = createContext<RouterValue | null>(null);

function useRouterContext(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('BespokeCore hooks must be used inside <BespokeApp>.');
  return value;
}

/**
 * The current page object (component name, props, url). Its props include the
 * shared ones — `usePage().props.auth` — typed through `interface SharedProps`.
 */
export function usePage<TProps extends object = {}>(): Omit<PageObject, 'props'> & { props: SharedProps & TProps } {
  return useRouterContext().page as Omit<PageObject, 'props'> & { props: SharedProps & TProps };
}

/** Programmatic navigation: `const { visit } = useRouter(); visit('/users/2')`. */
export function useRouter(): Pick<RouterValue, 'visit'> {
  return { visit: useRouterContext().visit };
}

export interface BespokeAppProps {
  initialPage: PageObject;
  initialComponent: PageComponent;
  resolve: ResolvePage;
}

/**
 * Root component on server and client. Navigations fetch the next page object
 * as JSON (via `PAGE_HEADER`) and swap the page component in place.
 */
export function BespokeApp({ initialPage, initialComponent, resolve }: BespokeAppProps) {
  // `key` changes remount the page component (fresh state); an unchanged key preserves it.
  const [current, setCurrent] = useState({ page: initialPage, Component: initialComponent, key: 0 });
  const inFlight = useRef<AbortController | null>(null);
  // The asset version this tab runs — the one of the page it was loaded with.
  const versionRef = useRef(initialPage.version ?? null);

  const show = useCallback(
    async (page: PageObject, history: 'push' | 'replace' | 'none', { preserveScroll = false, preserveState = false } = {}) => {
      const Component = await resolve(page.component);
      if (history === 'push') window.history.pushState(page, '', page.url);
      if (history === 'replace') window.history.replaceState(page, '', page.url);
      setCurrent((previous) => ({
        page,
        Component,
        key: preserveState && previous.Component === Component ? previous.key : previous.key + 1,
      }));
      if (history !== 'none' && !preserveScroll) window.scrollTo(0, 0);
    },
    [resolve],
  );

  const visit = useCallback(
    async (url: string, options: VisitOptions = {}): Promise<PageObject | undefined> => {
      const { method = 'get', data, replace = false, preserveScroll = false, headers = {} } = options;
      const preserveState = options.preserveState ?? method !== 'get';

      // A newer visit always wins over a slower, older one.
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      try {
        const request = buildRequest(url, method, data);
        const version = versionRef.current;
        const response = await fetch(request.url, {
          method: method.toUpperCase(),
          headers: { [PAGE_HEADER]: 'true', ...(version ? { [VERSION_HEADER]: version } : {}), ...request.headers, ...headers },
          body: request.body,
          signal: controller.signal,
        });
        const location = response.status === 409 ? response.headers.get(LOCATION_HEADER) : null;
        if (location) {
          // A new build was deployed: load the page fully, with the new assets.
          window.location.assign(location);
          return undefined;
        }
        if (response.headers.get(PAGE_HEADER) !== 'true') {
          // Not a page (e.g. a 401 JSON or a file download): let the browser handle it.
          window.location.assign(response.url);
          return undefined;
        }
        const page = (await response.json()) as PageObject;
        // Redirected back to the same URL (a failed form): replace, don't stack history entries.
        const sameUrl = page.url === window.location.pathname + window.location.search;
        await show(page, replace || (method !== 'get' && sameUrl) ? 'replace' : 'push', { preserveScroll, preserveState });
        return page;
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        return undefined;
      }
    },
    [show],
  );

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (isPageObject(event.state)) void show(event.state, 'none');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [show]);

  const router = useMemo(() => ({ page: current.page, visit }), [current.page, visit]);
  const { Component, page, key } = current;

  return (
    <RouterContext.Provider value={router}>
      <Component key={key} {...page.props} />
    </RouterContext.Provider>
  );
}

/** The CSRF token the server put into the readable `XSRF-TOKEN` cookie. */
export function xsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

function buildRequest(
  url: string,
  method: VisitMethod,
  data: VisitOptions['data'],
): { url: string; headers: Record<string, string>; body?: BodyInit } {
  if (method === 'get') {
    if (!data || data instanceof FormData) return { url, headers: {} };
    const target = new URL(url, window.location.href);
    for (const [key, value] of Object.entries(data)) if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    return { url: target.pathname + target.search + target.hash, headers: {} };
  }
  const token = xsrfToken();
  const headers: Record<string, string> = token ? { 'x-xsrf-token': token } : {};
  if (data instanceof FormData) return { url, headers, body: data }; // the browser sets the multipart boundary
  return { url, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) };
}
