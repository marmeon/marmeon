import { isPageObject, PAGE_HEADER, type PageObject } from '@bespokecore/http/page';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PageComponent, ResolvePage } from './pages.ts';

export interface VisitOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
}

interface RouterValue {
  page: PageObject;
  visit: (url: string, options?: VisitOptions) => Promise<void>;
}

const RouterContext = createContext<RouterValue | null>(null);

function useRouterContext(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('BespokeCore hooks must be used inside <BespokeApp>.');
  return value;
}

/** The current page object (component name, props, url). */
export function usePage(): PageObject {
  return useRouterContext().page;
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
  const [current, setCurrent] = useState({ page: initialPage, Component: initialComponent });
  const inFlight = useRef<AbortController | null>(null);

  const show = useCallback(
    async (page: PageObject, history: 'push' | 'replace' | 'none') => {
      const Component = await resolve(page.component);
      if (history === 'push') window.history.pushState(page, '', page.url);
      if (history === 'replace') window.history.replaceState(page, '', page.url);
      setCurrent({ page, Component });
      if (history === 'push') window.scrollTo(0, 0);
    },
    [resolve],
  );

  const visit = useCallback(
    async (url: string, { replace = false }: VisitOptions = {}) => {
      // A newer visit always wins over a slower, older one.
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      try {
        const response = await fetch(url, { headers: { [PAGE_HEADER]: 'true' }, signal: controller.signal });
        if (response.headers.get(PAGE_HEADER) !== 'true') {
          // Not a page (e.g. a 401 JSON or a file download): let the browser handle it.
          window.location.assign(response.url);
          return;
        }
        await show((await response.json()) as PageObject, replace ? 'replace' : 'push');
      } catch (error) {
        if (!controller.signal.aborted) throw error;
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
  const { Component, page } = current;

  return (
    <RouterContext.Provider value={router}>
      <Component {...page.props} />
    </RouterContext.Provider>
  );
}
