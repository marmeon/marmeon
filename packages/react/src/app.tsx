import type { PageObject, RouteManifest, SharedProps } from '@bespokecore/http/page';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ErrorBoundary, RenderErrorFallback, VisitFailure } from './fallbacks.tsx';
import { defaultTitle, HeadContext, TitleRegistry, type TitleTemplate } from './head.tsx';
import { Navigator, type VisitError, type VisitEvent, type VisitEvents, type VisitOptions } from './navigation.ts';
import { layoutsOf, type DefaultLayout, type PageComponent, type ResolvePage } from './pages.ts';
import { showProgress, type ProgressOptions } from './progress.ts';
import { RoutesContext } from './routes.ts';

export { xsrfToken } from './navigation.ts';
export type { Visit, VisitCallbacks, VisitError, VisitEvent, VisitEvents, VisitMethod, VisitOptions, VisitProgress } from './navigation.ts';

interface RouterValue {
  page: PageObject;
  /** Resolves with the page the visit ended on (undefined if it did not end on one — see `Navigator.visit`). */
  visit: (url: string, options?: VisitOptions) => Promise<PageObject | undefined>;
  /** The current page again from the server, keeping scroll position and component state. */
  reload: (options?: Omit<VisitOptions, 'method' | 'data'>) => Promise<PageObject | undefined>;
  /** Listens to the events of every visit; returns the function that stops listening (for an effect's cleanup). */
  on: <E extends VisitEvent>(event: E, listener: VisitEvents[E]) => () => void;
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

/** Programmatic navigation: `const { visit, reload, on } = useRouter(); visit('/users/2')`. */
export function useRouter(): Pick<RouterValue, 'visit' | 'reload' | 'on'> {
  const { visit, reload, on } = useRouterContext();
  return { visit, reload, on };
}

export interface BespokeAppProps {
  initialPage: PageObject;
  initialComponent: PageComponent;
  resolve: ResolvePage;
  /** Turns a page's `<Head title>` into the document title. */
  title?: TitleTemplate;
  /** The named routes the browser knows (`routes` of `bootstrap/routes.ts`) — for `route()`, `<Link route>` and `useForm(name, …)`. */
  routes?: RouteManifest;
  /** The layout of pages without their own `layout` (E35) — the same on the server and in the browser. */
  layout?: DefaultLayout;
  /** The progress bar of visits (shown after `delay` ms, default 250), or `false` for none. */
  progress?: ProgressOptions | false;
  /** Server rendering only: where `<Head>` records itself. */
  headCollector?: { title: string | undefined; tags: ReactElement[] };
}

interface Current {
  page: PageObject;
  Component: PageComponent;
  /** Changes remount the page component (fresh state); an unchanged key preserves it. */
  key: number;
}

/**
 * Root component on server and client. Navigations fetch the next page object as JSON (via `PAGE_HEADER`)
 * and swap the page component in place — inside its layouts, which stay mounted while the next page has
 * them too (E35). The {@link Navigator} keeps the history — without props (E36) — and the scroll positions.
 *
 * Errors: a page that throws while rendering shows the app's error page inside its layouts (once after a
 * fresh copy of its props from the server — what changed may be the props' shape, e.g. after a hot update);
 * a visit that fails (offline, 5xx) leaves the page as it is and shows the failure over it.
 */
export function BespokeApp({ initialPage, initialComponent, resolve, title = defaultTitle, routes, layout, progress, headCollector }: BespokeAppProps) {
  const [current, setCurrent] = useState<Current>({ page: initialPage, Component: initialComponent, key: 0 });
  const [failure, setFailure] = useState<VisitError | null>(null);

  // The navigator waits until a page is on screen before it restores the scroll position.
  const committed = useRef<(() => void)[]>([]);
  useLayoutEffect(() => {
    for (const done of committed.current.splice(0)) done();
  }, [current]);

  const render = useCallback(
    async (page: PageObject, { preserveState }: { preserveState: boolean }) => {
      const Component = await resolve(page.component);
      await new Promise<void>((done) => {
        committed.current.push(done);
        setCurrent((previous) => ({
          page,
          Component,
          key: preserveState && previous.Component === Component ? previous.key : previous.key + 1,
        }));
      });
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
  useEffect(() => {
    const nav = navigator.current;
    if (!nav) return undefined;
    const stops = [nav.on('error', setFailure), nav.on('start', () => setFailure(null))];
    if (progress !== false) stops.push(showProgress(nav, progress));
    return () => {
      for (const stop of stops) stop();
    };
    // The progress options are read once — like the navigator itself.
  }, []);

  const browser = useCallback(() => {
    if (!navigator.current) throw new Error('Visits run in the browser, not while rendering on the server.');
    return navigator.current;
  }, []);
  const visit = useCallback((url: string, options?: VisitOptions) => browser().visit(url, options), [browser]);
  const reload = useCallback((options?: Omit<VisitOptions, 'method' | 'data'>) => browser().reload(options), [browser]);
  const on = useCallback(<E extends VisitEvent>(event: E, listener: VisitEvents[E]) => browser().on(event, listener), [browser]);

  // A page that throws gets one fresh copy of its props from the server: after a hot update, the code may
  // expect a shape the props in memory do not have yet (the controller changed with it). Throws again → fallback.
  const retried = useRef<PageObject | null>(null);
  const onPageError = useCallback((page: PageObject) => {
    const nav = navigator.current;
    if (!nav) return;
    if (retried.current && retried.current !== page && retried.current.url === page.url) {
      retried.current = null;
      return;
    }
    retried.current = page;
    void nav.reload({ preserveState: false });
  }, []);
  const onPageRendered = useCallback((page: PageObject) => {
    if (retried.current && retried.current !== page) retried.current = null;
  }, []);

  const router = useMemo(() => ({ page: current.page, visit, reload, on }), [current.page, visit, reload, on]);
  const { Component, page, key } = current;

  const titles = useMemo(() => (typeof document === 'undefined' ? undefined : new TitleRegistry(title)), [title]);
  const head = useMemo(() => ({ template: title, collector: headCollector, titles }), [title, headCollector, titles]);

  const content = (
    <ErrorBoundary resetKey={page} onError={() => onPageError(page)} onRendered={() => onPageRendered(page)} fallback={(error) => <RenderErrorFallback resolve={resolve} error={error} />}>
      <Component key={key} {...page.props} />
    </ErrorBoundary>
  );
  // Same layout at the same depth → the same element type in the same place: React keeps it mounted.
  const tree = layoutsOf(Component, page.component, layout).reduceRight<ReactNode>((children, Layout) => <Layout>{children}</Layout>, content);

  return (
    <HeadContext.Provider value={head}>
      <RoutesContext.Provider value={routes}>
        <RouterContext.Provider value={router}>
          {/* A layout that throws takes the whole page down — to the error page, without layouts. */}
          <ErrorBoundary resetKey={page} fallback={(error) => <RenderErrorFallback resolve={resolve} error={error} />}>
            {tree}
          </ErrorBoundary>
          <VisitFailure failure={failure} resolve={resolve} onDismiss={() => setFailure(null)} />
        </RouterContext.Provider>
      </RoutesContext.Provider>
    </HeadContext.Provider>
  );
}
