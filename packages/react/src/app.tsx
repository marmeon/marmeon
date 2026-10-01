import {
  loadPageMessages,
  Navigator,
  pageLocale,
  showProgress,
  TitleRegistry,
  type PrefetchOptions,
  type ProgressOptions,
  type TitleTemplate,
  type VisitException,
  type VisitEvent,
  type VisitEvents,
  type VisitOptions,
} from '@bespokecore/http/client';
import type { PageObject, PageProps, RouteManifest, SharedProps } from '@bespokecore/http/page';
import type { Catalog, MessageLoader } from '@bespokecore/i18n/messages';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ErrorBoundary, RenderErrorFallback, VisitFailure } from './fallbacks.tsx';
import { defaultTitle, HeadContext, type HeadCollector } from './head.tsx';
import { I18nContext } from './i18n.tsx';
import { layoutsOf, type DefaultLayout, type PageComponent, type ResolvePage } from './pages.ts';
import { RoutesContext } from './routes.ts';

// The visit types of the client core, under the names React apps already import them by.
export type {
  PrefetchOptions,
  ProgressOptions,
  Visit,
  VisitCallbacks,
  VisitEvent,
  VisitEvents,
  VisitException,
  VisitMethod,
  VisitOptions,
  VisitProgress,
} from '@bespokecore/http/client';

/** The props of page `T`: a controller (`PageProps<T>`) or the props themselves. */
type PropsOf<T> = T extends { handle: (...args: never[]) => unknown } ? PageProps<T> : T;

/**
 * The name of a prop of page `T` (a controller or its props) — any string when `T` is not given. What a partial
 * reload asks for (`only`, `except`) and what `<Deferred data>` waits for.
 */
export type PropName<T> = unknown extends T ? string : keyof PropsOf<T> & string;

/** A partial reload's options, typed against the props of page `T`. */
export interface PartialReloadOptions<T = unknown> {
  /** Only these props — the server computes and sends nothing else (and `always()` props). */
  only?: readonly PropName<T>[];
  /** Every prop but these. */
  except?: readonly PropName<T>[];
  /** Replace these instead of merging them (`merge()` props). */
  reset?: readonly PropName<T>[];
}

/** {@link VisitOptions}, with the props of a partial reload checked against page `T`. */
export type TypedVisitOptions<T = unknown> = Omit<VisitOptions, keyof PartialReloadOptions> & PartialReloadOptions<T>;

/** {@link TypedVisitOptions} of a reload — a GET of the current URL; `data` goes into its query string. */
export type ReloadOptions<T = unknown> = Omit<TypedVisitOptions<T>, 'method' | 'data'> & { data?: Record<string, unknown> };

/** Programmatic navigation, from {@link useRouter}. */
export interface Router<T = unknown> {
  /** Resolves with the page the visit ended on (undefined if it did not end on one — see `Navigator.visit`). */
  visit(url: string, options?: TypedVisitOptions<T>): Promise<PageObject | undefined>;
  /** The current page again from the server, keeping scroll position and component state — `reload({ only: ['stats'] })`. */
  reload(options?: ReloadOptions<T>): Promise<PageObject | undefined>;
  /**
   * Fetches a page ahead of the visit — GET only, kept in memory for `cacheFor` ms (default 30 s); a visit of that
   * URL then shows it at once. What `<Link prefetch>` does on hover.
   */
  prefetch(url: string, options?: PrefetchOptions): Promise<void>;
  /** Listens to the events of every visit; returns the function that stops listening (for an effect's cleanup). */
  on<E extends VisitEvent>(event: E, listener: VisitEvents[E]): () => void;
}

interface RouterValue extends Router {
  page: PageObject;
  /** The navigator — null while rendering on the server (for the hooks of this package). */
  navigator(): Navigator | null;
}

const RouterContext = createContext<RouterValue | null>(null);

export function useRouterContext(): RouterValue {
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

/**
 * Programmatic navigation: `const { visit, reload, on } = useRouter(); visit('/users/2')`. Given the page's
 * controller (or props), the props of a partial reload are checked against the page:
 *
 * ```ts
 * const router = useRouter<ShowUserProfileController>();
 * router.reload({ only: ['stats'] });            // 'stat' would be a compile error
 * ```
 */
export function useRouter<T = unknown>(): Router<T> {
  const { visit, reload, prefetch, on } = useRouterContext();
  return useMemo(() => ({ visit, reload, prefetch, on }) as Router<T>, [visit, reload, prefetch, on]);
}

export interface BespokeAppProps {
  initialPage: PageObject;
  initialComponent: PageComponent;
  resolve: ResolvePage;
  /** Turns a page's `<Head title>` into the document title. */
  title?: TitleTemplate;
  /** The named routes the browser knows (`routes` of `virtual:bespoke/routes`) — for `route()`, `<Link route>` and `useForm(name, …)`. */
  routes?: RouteManifest;
  /** The layout of pages without their own `layout` (E35) — the same on the server and in the browser. */
  layout?: DefaultLayout;
  /** The progress bar of visits (shown after `delay` ms, default 250), or `false` for none. */
  progress?: ProgressOptions | false;
  /** Server rendering only: where `<Head>` records itself. */
  headCollector?: HeadCollector;
  /**
   * The app's language files (`createMessageLoader(lang)` of @bespokecore/i18n/messages) — each page renders with the
   * messages of its `locale`, loaded before it renders (`useTranslation`). Without them, `useTranslation` throws.
   */
  messages?: MessageLoader;
  /** The first page's messages, loaded before hydrating (by `createBespokeApp` and the SSR entry). */
  initialCatalog?: Catalog;
}

interface Current {
  page: PageObject;
  Component: PageComponent;
  /** The page's messages (in its locale). */
  catalog: Catalog | undefined;
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
export function BespokeApp({
  initialPage,
  initialComponent,
  resolve,
  title = defaultTitle,
  routes,
  layout,
  progress,
  headCollector,
  messages,
  initialCatalog,
}: BespokeAppProps) {
  const [current, setCurrent] = useState<Current>({ page: initialPage, Component: initialComponent, catalog: initialCatalog, key: 0 });
  const [failure, setFailure] = useState<VisitException | null>(null);

  // The navigator waits until a page is on screen before it restores the scroll position.
  const committed = useRef<(() => void)[]>([]);
  useLayoutEffect(() => {
    for (const done of committed.current.splice(0)) done();
  }, [current]);

  const render = useCallback(
    async (page: PageObject, { preserveState }: { preserveState: boolean }) => {
      // The page's component and its locale's messages, both before it renders: a page in another language (another
      // tab switched it) loads that language's files first.
      const [Component, catalog] = await Promise.all([resolve(page.component), loadPageMessages(page, messages)]);
      await new Promise<void>((done) => {
        committed.current.push(done);
        setCurrent((previous) => ({
          page,
          Component,
          catalog,
          key: preserveState && previous.Component === Component ? previous.key : previous.key + 1,
        }));
      });
    },
    [resolve, messages],
  );
  const renderRef = useRef(render);
  renderRef.current = render;

  // One navigator per app, in the browser only (the server renders a single page). Created during the first
  // render, so a page's own effects — which run before this component's — can already visit.
  const navigator = useRef<Navigator | null>(null);
  if (navigator.current === null && typeof window !== 'undefined') {
    navigator.current = new Navigator({ initialPage, render: (page, options) => renderRef.current(page, options) });
  }
  useEffect(() => {
    // When the first page became interactive (hydrated, or rendered when the server sent no markup) — for measuring.
    if (typeof performance !== 'undefined') performance.mark('bespoke:hydrated');
    return navigator.current?.start();
  }, []);
  useEffect(() => {
    const nav = navigator.current;
    if (!nav) return undefined;
    // A new visit takes the failure notice away — loading deferred props in the background does not.
    const stops = [nav.on('exception', setFailure), nav.on('start', (visit) => visit.async || setFailure(null))];
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
  const reload = useCallback((options?: ReloadOptions) => browser().reload(options), [browser]);
  // A prefetch while rendering on the server (an effect never runs there) has nothing to do.
  const prefetch = useCallback((url: string, options?: PrefetchOptions) => navigator.current?.prefetch(url, options) ?? Promise.resolve(), []);
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

  const getNavigator = useCallback(() => navigator.current, []);
  const router = useMemo(
    () => ({ page: current.page, visit, reload, prefetch, on, navigator: getNavigator }),
    [current.page, visit, reload, prefetch, on, getNavigator],
  );
  const { Component, page, key, catalog } = current;

  const locale = messages ? pageLocale(page, messages) : page.locale;
  const i18n = useMemo(() => (catalog && locale ? { catalog, locale } : null), [catalog, locale]);
  // The document's language follows the page's (the server set it for the first one).
  useEffect(() => {
    if (locale && typeof document !== 'undefined' && document.documentElement.lang !== locale) document.documentElement.lang = locale;
  }, [locale]);

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
        <I18nContext.Provider value={i18n}>
          <RouterContext.Provider value={router}>
            {/* A layout that throws takes the whole page down — to the error page, without layouts. */}
            <ErrorBoundary resetKey={page} fallback={(error) => <RenderErrorFallback resolve={resolve} error={error} />}>
              {tree}
            </ErrorBoundary>
            <VisitFailure failure={failure} resolve={resolve} onDismiss={() => setFailure(null)} />
          </RouterContext.Provider>
        </I18nContext.Provider>
      </RoutesContext.Provider>
    </HeadContext.Provider>
  );
}
