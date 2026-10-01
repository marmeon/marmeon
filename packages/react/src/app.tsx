import type { PageObject, RouteManifest, SharedProps } from '@bespokecore/http/page';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { defaultTitle, HeadContext, type TitleTemplate } from './head.tsx';
import { Navigator, type VisitOptions } from './navigation.ts';
import type { PageComponent, ResolvePage } from './pages.ts';
import { RoutesContext } from './routes.ts';

export { xsrfToken } from './navigation.ts';
export type { VisitMethod, VisitOptions } from './navigation.ts';

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
  /** Turns a page's `<Head title>` into the document title. */
  title?: TitleTemplate;
  /** The named routes the browser knows (`routes` of `bootstrap/routes.ts`) — for `route()`, `<Link route>` and `useForm(name, …)`. */
  routes?: RouteManifest;
  /** Server rendering only: where `<Head>` records itself. */
  headCollector?: { title: string | undefined; tags: ReactElement[] };
}

/**
 * Root component on server and client. Navigations fetch the next page object
 * as JSON (via `PAGE_HEADER`) and swap the page component in place; the
 * {@link Navigator} keeps the history — without props (E36).
 */
export function BespokeApp({ initialPage, initialComponent, resolve, title = defaultTitle, routes, headCollector }: BespokeAppProps) {
  // `key` changes remount the page component (fresh state); an unchanged key preserves it.
  const [current, setCurrent] = useState({ page: initialPage, Component: initialComponent, key: 0 });

  const render = useCallback(
    async (page: PageObject, { preserveState }: { preserveState: boolean }) => {
      const Component = await resolve(page.component);
      setCurrent((previous) => ({
        page,
        Component,
        key: preserveState && previous.Component === Component ? previous.key : previous.key + 1,
      }));
    },
    [resolve],
  );
  const renderRef = useRef(render);
  renderRef.current = render;

  // One navigator per app, in the browser only (the server renders a single page). Created during the first
  // render, so a page's own effects — which run before this component's — can already visit.
  const navigator = useRef<Navigator | null>(null);
  if (navigator.current === null && typeof window !== 'undefined') {
    navigator.current = new Navigator({ initialPage, render: (page, options) => renderRef.current(page, options) });
  }
  useEffect(() => navigator.current?.start(), []);

  const visit = useCallback((url: string, options?: VisitOptions) => {
    if (!navigator.current) throw new Error('visit() runs in the browser, not while rendering on the server.');
    return navigator.current.visit(url, options);
  }, []);

  const router = useMemo(() => ({ page: current.page, visit }), [current.page, visit]);
  const { Component, page, key } = current;

  const head = useMemo(() => ({ template: title, collector: headCollector }), [title, headCollector]);

  return (
    <HeadContext.Provider value={head}>
      <RoutesContext.Provider value={routes}>
        <RouterContext.Provider value={router}>
          <Component key={key} {...page.props} />
        </RouterContext.Provider>
      </RoutesContext.Provider>
    </HeadContext.Provider>
  );
}
