import { createPoll, resolveRoute, type Region, type RegionFailure, type RegionSnapshot, type RegionStatus } from '@bespokecore/http/client';
import type {
  BrowserRouteNameInput,
  CheckIslandRouteName,
  IslandProps as IslandPropsOf,
  ParamsOf,
  QueryFields,
  QueryOf,
  QueryParams,
  RegionObject,
} from '@bespokecore/http/page';
import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { RegionOwnerContext, useRouterContext } from './app.tsx';
import { ErrorBoundary } from './fallbacks.tsx';
import type { PageComponent, ResolvePage } from './pages.ts';
import { RoutesContext } from './routes.ts';

/** The path parameters of the island's route: required when its path has required ones. */
type ParamsProp<N extends string> = {} extends ParamsOf<N> ? { params?: ParamsOf<N> } : { params: ParamsOf<N> };

/**
 * `<Island>`'s props for route `N` — checked against `bootstrap/routes.ts`. (The props of the island's *view* are
 * `IslandProps<Controller>` of @bespokecore/http, like `PageProps`.)
 */
export type IslandElementProps<N extends string = string> = {
  /** An island route (its controller answers `this.island(…)`) — a page route is a compile error. */
  route: CheckIslandRouteName<N>;
  /** Its first query, typed by its query schema (E55) — `useIsland().reload({ query })` changes it later. */
  query?: QueryParams<N>;
  /** Shown until the island is there. */
  fallback?: ReactNode;
  /**
   * Shown when the island's route turns the user away — its middleware redirects (not signed in, not verified), or it
   * answers 401/403. Default: nothing. The page never navigates because of an island (E52).
   */
  unauthorized?: ReactNode;
  /** Shown when it failed (a 5xx, offline, an error while rendering it) — `retry` asks again. Default: a short notice. */
  error?: ReactNode | ((retry: () => void) => ReactNode);
  /** `'visible'`: load once it is scrolled into view (IntersectionObserver), not with the page. Default `'eager'`. */
  load?: 'eager' | 'visible';
  /** Load this many pixels before it comes into view (with `load="visible"`, default 0). */
  buffer?: number;
  /** Reload every `poll` ms (in the background, paused while the tab is hidden) — once it is loaded. */
  poll?: number;
  /** Keep polling while the tab is hidden. */
  keepAlive?: boolean;
  /** The element around it (default `div`) — it carries `data-island` and `data-status`, and is what `load="visible"` watches. */
  as?: string;
  className?: string;
  id?: string;
} & ParamsProp<N>;

/** The data of the island around a component — what `useIsland` reads. */
interface IslandValue {
  readonly region: Region;
  readonly snapshot: RegionSnapshot;
}

const IslandContext = createContext<IslandValue | null>(null);

const LOADING: RegionSnapshot = { status: 'loading', region: undefined, pending: false, failure: undefined };
const noSubscription = () => () => {};

/** Island views resolved already, by `resolve` — rendered without a frame of fallback when they come back (Back/Forward). */
const resolvedViews = new WeakMap<ResolvePage, Map<string, PageComponent>>();

/**
 * A part of the page that loads by itself — the view of another route (E48, E50): its own controller, middleware,
 * authorization and query, reusable on any page.
 *
 * ```tsx
 * <Island route="dashboard.sign-ins" query={{ limit: 5 }} fallback={<WidgetSkeleton />} />
 * <Island route="dashboard.activity" load="visible" poll={15_000} fallback={<WidgetSkeleton />} />
 * <Island route="dashboard.members" fallback={<WidgetSkeleton />} unauthorized={<p>Verify your address to see this.</p>} />
 * ```
 *
 * In the browser, it loads after the page has rendered (parallel to the other islands; two identical ones share one
 * request), into the memory of the page's history entry: Back/Forward shows it again without a request, and nothing of it
 * goes into `history.state`. A redirect, 401 or 403 of its route shows `unauthorized`, a failure `error` — the page never
 * navigates, and the other islands stay. Islands are never prefetched (E52). Links inside navigate the page (E51).
 */
export function Island<const N extends BrowserRouteNameInput>(props: IslandElementProps<N>) {
  const router = useRouterContext();
  const manifest = useContext(RoutesContext);
  const owner = useContext(RegionOwnerContext);
  const { route, params, query, fallback = null, unauthorized = null, error, load = 'eager', buffer = 0, poll, keepAlive = false, as = 'div', className, id } =
    props as IslandElementProps & { params?: Record<string, string | number> };
  const url = resolveRoute(manifest, route, params, query).url;
  const navigator = router.navigator();
  // One region per URL and history entry: the entry's memory has it after Back/Forward.
  const region = useMemo(() => (navigator && owner ? navigator.region(url, { owner }) : null), [navigator, owner, url]);
  const snapshot = useSyncExternalStore(region?.subscribe ?? noSubscription, () => region?.snapshot ?? LOADING, () => LOADING);

  const element = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(load !== 'visible');
  useEffect(() => {
    if (load !== 'visible' || visible) return undefined;
    if (typeof IntersectionObserver === 'undefined' || !element.current) {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setVisible(true);
      },
      { rootMargin: `${buffer}px` },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [load, visible, buffer]);

  useEffect(() => {
    if (region && visible) void region.load();
  }, [region, visible]);

  const ready = snapshot.status === 'ready';
  useEffect(() => {
    if (!region || !visible || !ready || !poll) return undefined;
    const polling = createPoll(() => region.reload(), poll, { keepAlive });
    polling.start();
    return () => polling.stop();
  }, [region, visible, ready, poll, keepAlive]);

  const retry = () => void region?.reload();
  const failed = typeof error === 'function' ? error(retry) : (error ?? <IslandFailure failure={snapshot.failure} retry={retry} />);
  let content: ReactNode;
  if (snapshot.region && region) {
    content = (
      <ErrorBoundary resetKey={snapshot.region} fallback={() => failed}>
        <IslandContext.Provider value={{ region, snapshot }}>
          <IslandView resolve={router.resolve} region={snapshot.region} fallback={fallback} />
        </IslandContext.Provider>
      </ErrorBoundary>
    );
  } else if (snapshot.status === 'unauthorized' || snapshot.status === 'forbidden') {
    content = unauthorized;
  } else if (snapshot.status === 'exception') {
    content = failed;
  } else {
    content = fallback;
  }
  return createElement(
    as,
    {
      ref: element,
      className,
      id,
      'data-island': route,
      'data-status': snapshot.status,
      'aria-busy': snapshot.pending || snapshot.status === 'loading' ? true : undefined,
    },
    content,
  );
}

/** The island's view, by name — resolved like a page (and without its layouts: the page has them). */
function IslandView({ resolve, region, fallback }: { resolve: ResolvePage; region: RegionObject; fallback: ReactNode }) {
  const known = resolvedViews.get(resolve)?.get(region.component);
  const [loaded, setLoaded] = useState<{ name: string; Component: PageComponent } | null>(null);
  useEffect(() => {
    if (known) return undefined;
    let current = true;
    void resolve(region.component).then((Component) => {
      let views = resolvedViews.get(resolve);
      if (!views) resolvedViews.set(resolve, (views = new Map()));
      views.set(region.component, Component);
      if (current) setLoaded({ name: region.component, Component });
    });
    return () => {
      current = false;
    };
  }, [resolve, region.component, known]);
  const Component = known ?? (loaded?.name === region.component ? loaded.Component : undefined);
  return Component ? <Component {...region.props} /> : fallback;
}

/** The default `error` of an island — a short notice with a retry (framework text, English like the other fallbacks). */
function IslandFailure({ failure, retry }: { failure: RegionFailure | undefined; retry: () => void }) {
  return (
    <p role="alert" data-bespoke-failure="island">
      {failure?.status === undefined ? 'This part could not be loaded — the server could not be reached.' : 'This part could not be loaded.'}{' '}
      <button type="button" onClick={retry}>
        Try again
      </button>
    </p>
  );
}

type IslandAction = { handle: (...args: never[]) => unknown };

/**
 * The query of island `C` as `reload({ query })` takes it: some fields, typed by its query schema's output — any fields
 * without a controller given (`useIsland()`), a message for an island without a query schema.
 */
type IslandQueryPatch<C> = IslandAction extends C
  ? Readonly<Record<string, unknown>>
  : [QueryOf<C>] extends [never]
    ? 'this island has no query schema — give its controller `static request = defineRequest({ query })`'
    : QueryFields<QueryOf<C>>;

/** A reload of the island around the component — `only`/`except`/`reset` checked against its props. */
export interface IslandReloadOptions<C extends IslandAction = IslandAction> {
  /** Another query — some fields; `undefined` takes one back to its default. (A compile error for an island without a query schema.) */
  query?: IslandQueryPatch<C>;
  only?: readonly (keyof IslandPropsOf<C> & string)[];
  except?: readonly (keyof IslandPropsOf<C> & string)[];
  /** Replace these instead of merging them — by default those of `only` when the query changes. */
  reset?: readonly (keyof IslandPropsOf<C> & string)[];
}

/** What `useIsland` gives the component of an island. */
export interface IslandState<C extends IslandAction = IslandAction> {
  /** Its props (also the component's own props). */
  readonly props: IslandPropsOf<C>;
  /** Its query, defaults filled in — what its controller saw as `ctx.query`. */
  readonly query: IslandAction extends C ? Record<string, unknown> : [QueryOf<C>] extends [never] ? Record<string, never> : QueryOf<C>;
  readonly status: RegionStatus;
  /** A request of the island is under way (a reload, a poll). */
  readonly pending: boolean;
  /** Why the last reload failed — the island still shows what it had. */
  readonly failure: RegionFailure | undefined;
  /** Asks the server again: the same query, another one, or some props — only this island. */
  reload(options?: IslandReloadOptions<C>): Promise<void>;
}

/**
 * The island around this component (E51) — inside the view an `<Island>` renders:
 *
 * ```tsx
 * export default function RecentSignIns({ entries }: IslandProps<ShowRecentSignInsController>) {
 *   const island = useIsland<ShowRecentSignInsController>();
 *   return <button onClick={() => island.reload({ query: { limit: 10 } })} disabled={island.pending}>More</button>;
 * }
 * ```
 *
 * `reload({ query })` is typed by the island route's query schema (`QueryOf<C>`): a wrong field or value is a compile error.
 */
export function useIsland<C extends IslandAction = IslandAction>(): IslandState<C> {
  const value = useContext(IslandContext);
  if (!value) throw new Error('useIsland() is for the view of an island — the component an <Island route> renders.');
  const { region, snapshot } = value;
  return useMemo(
    () =>
      ({
        props: snapshot.region?.props ?? {},
        query: region.query,
        status: snapshot.status,
        pending: snapshot.pending,
        failure: snapshot.failure,
        reload: (options?: IslandReloadOptions<C>) => region.reload(options as Parameters<Region['reload']>[0]),
      }) as unknown as IslandState<C>,
    [region, snapshot],
  );
}
