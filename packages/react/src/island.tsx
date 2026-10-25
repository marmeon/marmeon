import { regionInitial, type PropsPatch, type Region, type ReloadSpec, type RegionSnapshot } from '@marmeon/http/client/adapter';
import { createPoll, resolveRoute, type OptimisticUpdate, type RegionFailure, type Reloading, type RegionStatus } from '@marmeon/http/client';
import { pageQueryOf } from '@marmeon/http/client/adapter';
import { islands } from '@marmeon/http/client/adapter';
import type {
  BrowserRouteNameInput,
  CheckIslandRouteName,
  IslandProps as IslandPropsOf,
  ParamsOf,
  QueryFields,
  QueryOf,
  QueryParams,
  RegionResult,
} from '@marmeon/http/page';
import type {
  RegionObject,
} from '@marmeon/http/protocol';
import { scriptJson } from '@marmeon/http/client/adapter';
import {
  createContext,
  createElement,
  Suspense,
  use,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { RegionOwnerContext, useRouterContext, type CheckedPatch } from './app.tsx';
import { ErrorBoundary } from './fallbacks.tsx';
import { IslandHeadContext } from './head.tsx';
import { DataScript, SsrContext, streamedJson, streamedText, type SsrResolvers } from './streamed.tsx';
import type { ResolvePage } from './pages.ts';
import { RoutesContext } from './routes.ts';
import { viewOf } from './views.ts';
import { IslandScopeContext } from './island-scope.ts';

/** The path parameters of the island's route: required when its path has required ones. */
type ParamsProp<N extends string> = {} extends ParamsOf<N> ? { params?: ParamsOf<N> } : { params: ParamsOf<N> };

/**
 * `<Island>`'s props for route `N` — checked against `bootstrap/routes.ts`. (The props of the island's *view* are
 * `IslandProps<Controller>` of @marmeon/http, like `PageProps`.)
 */
export type IslandElementProps<N extends string = string> = {
  /** An island route (its controller answers `this.island(…)`) — a page route is a compile error. */
  route: CheckIslandRouteName<N>;
  /** Its first query, typed by its query schema — `useIsland().reload({ query })` changes it later. */
  query?: QueryParams<N>;
  /** Shown until the island is there. */
  fallback?: ReactNode;
  /**
   * Shown when the island's route turns the user away — its middleware redirects (not signed in, not verified), or it
   * answers 401/403. Default: nothing. The page never navigates because of an island.
   */
  unauthorized?: ReactNode;
  /** Shown when it failed (a 5xx, offline, an error while rendering it) — `retry` asks again. Default: a short notice. */
  error?: ReactNode | ((retry: () => void) => ReactNode);
  /** `'visible'`: load once it is scrolled into view (IntersectionObserver), not with the page. Default `'eager'`. */
  load?: 'eager' | 'visible';
  /** Load this many pixels before it comes into view (with `load="visible"`, default 0). */
  buffer?: number;
  /** Reload every `pollMs` ms (in the background, paused while the tab is hidden) — once it is loaded. */
  pollMs?: number;
  /** Keep polling while the tab is hidden. */
  keepAlive?: boolean;
  /** The element around it (default `div`) — it carries `data-island` and `data-status`, and is what `load="visible"` watches. */
  as?: string;
  className?: string;
  id?: string;
} & ParamsProp<N>;

/** The data of the island around a component — what `useIsland` reads. */
interface IslandValue {
  readonly snapshot: RegionSnapshot;
  readonly query: Record<string, unknown>;
  reload(options?: Parameters<Region['reload']>[0]): Promise<void>;
  /** Its region — null while rendering on the server. */
  readonly region: Region | null;
}

const IslandContext = createContext<IslandValue | null>(null);


const LOADING: RegionSnapshot = { status: 'loading', region: undefined, pending: false, failure: undefined };
const NOT_RESOLVED: RegionResult = { status: 'browser' };
const noSubscription = () => () => {};
const noReload = () => Promise.resolve();

/**
 * A part of the page that loads by itself — the view of another route: its own controller, middleware, authorization and
 * query, reusable on any page. It lives in the memory of the page's history entry — nothing of it goes into `history.state` —
 * and is never prefetched. Links inside navigate the page. See docs/deferred-props.md#how-islands-load.
 */
export function Island<const N extends BrowserRouteNameInput>(props: IslandElementProps<N>) {
  const manifest = useContext(RoutesContext);
  const { route, params, query, fallback = null, load = 'eager', as = 'div', className, id } = props as IslandElementProps & {
    params?: Record<string, string | number>;
  };
  const url = resolveRoute(manifest, route, params, query).url;
  const scriptId = `marmeon-island-${useId()}`;
  // Until its part has rendered in the browser (hydrated), the element stays the same: a page update reaching a boundary
  // that is still streaming would make React render it in the browser instead — and load the island again.
  const [shown, setShown] = useState(false);
  const onShown = useCallback(() => setShown(true), []);
  const body = <IslandBody {...(props as IslandElementProps)} url={url} scriptId={scriptId} streamed={load !== 'visible'} onShown={onShown} />;
  const boundary =
    load === 'visible' ? (
      body
    ) : (
      <Suspense
        fallback={
          <IslandFrame as={as} route={route} className={className} id={id} snapshot={LOADING}>
            {fallback}
          </IslandFrame>
        }
      >
        {body}
      </Suspense>
    );
  // Pinned on purpose until shown (see above): the first element, for this URL.
  const pinned = useMemo(() => boundary, [url, load]);
  return shown ? boundary : pinned;
}

type BodyProps = IslandElementProps & { url: string; scriptId: string; streamed: boolean; onShown: () => void };

/** On the server: the island as the page's request resolved it. In the browser: its region. */
function IslandBody(props: BodyProps) {
  const ssr = useContext(SsrContext);
  return ssr ? <ServerIsland {...props} ssr={ssr} /> : <BrowserIsland {...props} />;
}

/**
 * The island on the server: its request, resolved in-process, then its view — and, in the same boundary, what the
 * browser needs to show it without a request: a data block with the region object, or with only the outcome
 * (`unauthorized`, `forbidden`: no data ever leaves). Left to the browser (`browser`): the fallback, and no data block.
 */
function ServerIsland({ ssr, url, streamed, scriptId, onShown: _onShown, ...props }: BodyProps & { ssr: SsrResolvers }) {
  const result = streamed ? use(ssr.island(url)) : NOT_RESOLVED;
  const snapshot = snapshotOf(result);
  const value: IslandValue = { snapshot, query: snapshot.region ? pageQueryOf(snapshot.region) : {}, reload: noReload, region: null };
  return (
    <>
      <IslandContent {...props} snapshot={snapshot} value={value} />
      {result.status !== 'browser' && <DataScript id={scriptId} json={scriptJson(result)} />}
    </>
  );
}

function snapshotOf(result: RegionResult): RegionSnapshot {
  switch (result.status) {
    case 'ready':
      return { status: 'ready', region: result.region, pending: false, failure: undefined };
    case 'unauthorized':
    case 'forbidden':
      return { status: result.status, region: undefined, pending: false, failure: undefined };
    case 'exception':
      return { status: 'exception', region: undefined, pending: false, failure: { status: result.failure.status, message: result.failure.message } };
    default:
      return LOADING;
  }
}

/** The island in the browser: its region — started with what the server streamed into its boundary, else loading itself. */
function BrowserIsland({ url, streamed, scriptId, onShown, ...props }: BodyProps) {
  const router = useRouterContext();
  const owner = useContext(RegionOwnerContext);
  const { load = 'eager', buffer = 0, pollMs, keepAlive = false } = props;
  // What the server streamed into this boundary — read once, while hydrating (and rendered again as it was).
  const [text] = useState(() => (streamed ? streamedText(scriptId) : undefined));
  const navigator = router.navigator();
  // One region per URL and history entry: the entry's memory has it after Back/Forward.
  const region = useMemo(() => {
    if (!navigator || !owner) return null;
    const result = parseResult(text);
    // The islands feature attaches with the first island — in the browser only (BrowserIsland never renders on the server).
    return navigator.use(islands).region(url, { owner, initial: result && regionInitial(result) });
  }, [navigator, owner, url, text]);
  // Hydrating, the markup is the server's: what it streamed (or loading, for an island it left to the browser).
  const snapshot = useSyncExternalStore(
    region?.subscribe ?? noSubscription,
    () => region?.snapshot ?? LOADING,
    () => (text !== undefined ? region?.snapshot : undefined) ?? LOADING,
  );

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

  useEffect(onShown, [onShown]);

  useEffect(() => {
    // Streamed with the page: nothing to load (only deferred props of its own, if it has any).
    if (region && visible) void region.load();
  }, [region, visible]);

  const ready = snapshot.status === 'ready';
  useEffect(() => {
    if (!region || !visible || !ready || !pollMs) return undefined;
    const polling = createPoll(() => region.reload(), pollMs, { keepAlive });
    polling.start();
    return () => polling.stop();
  }, [region, visible, ready, pollMs, keepAlive]);

  const value = useMemo<IslandValue | null>(
    () => (region ? { snapshot, query: region.query, reload: (options) => region.reload(options), region } : null),
    [region, snapshot],
  );
  return (
    <>
      <IslandContent {...props} snapshot={snapshot} value={value} frameRef={element} />
      {text !== undefined && <DataScript id={scriptId} json={text} />}
    </>
  );
}

function parseResult(text: string | undefined): RegionResult | undefined {
  const result = streamedJson<RegionResult>(text);
  return typeof result?.status === 'string' ? result : undefined;
}

type ContentProps = IslandElementProps & { snapshot: RegionSnapshot; value: IslandValue | null; frameRef?: RefObject<HTMLElement | null> };

/** What an island shows for its snapshot — the same on the server and in the browser, so it hydrates. */
function IslandContent({ route, fallback = null, unauthorized = null, error, as = 'div', className, id, snapshot, value, frameRef }: ContentProps) {
  const { resolve } = useRouterContext();
  const retry = () => void value?.reload();
  const failed = typeof error === 'function' ? error(retry) : (error ?? <IslandFailure failure={snapshot.failure} retry={retry} />);
  let content: ReactNode;
  if (snapshot.region && value) {
    content = (
      <ErrorBoundary resetKey={snapshot.region} fallback={() => failed}>
        <IslandContext.Provider value={value}>
          <IslandScopeContext.Provider value={value.region?.id ?? 'ssr'}>
            <IslandHeadContext.Provider value={snapshot.region.component}>
              <Suspense fallback={fallback}>
                <IslandView resolve={resolve} region={snapshot.region} />
              </Suspense>
            </IslandHeadContext.Provider>
          </IslandScopeContext.Provider>
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
  return (
    <IslandFrame as={as} route={route} className={className} id={id} snapshot={snapshot} frameRef={frameRef}>
      {content}
    </IslandFrame>
  );
}

interface FrameProps {
  as: string;
  route: string;
  className: string | undefined;
  id: string | undefined;
  snapshot: RegionSnapshot;
  frameRef?: RefObject<HTMLElement | null> | undefined;
  children: ReactNode;
}

/** The element around an island — `data-island`, `data-status`, and `aria-busy` while it loads. */
function IslandFrame({ as, route, className, id, snapshot, frameRef, children }: FrameProps) {
  return createElement(
    as,
    {
      ref: frameRef,
      className,
      id,
      'data-island': route,
      'data-status': snapshot.status,
      'aria-busy': snapshot.pending || snapshot.status === 'loading' ? true : undefined,
    },
    children,
  );
}

/**
 * The island's view, by name — resolved like a page (and without its layouts: the page has them). A view that is not
 * loaded yet suspends: its boundary shows the fallback — or, hydrating, keeps the server's markup until it is there.
 */
function IslandView({ resolve, region }: { resolve: ResolvePage; region: RegionObject }) {
  const Component = viewOf(resolve, region.component);
  return <Component {...region.props} />;
}

/** The default `error` of an island — a short notice with a retry (framework text, English like the other fallbacks). */
function IslandFailure({ failure, retry }: { failure: RegionFailure | undefined; retry: () => void }) {
  return (
    <p role="alert" data-marmeon-failure="island">
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
  /**
   * A patch of the island's props for an action — shown at once, rolled back unless it succeeds; typed against its props:
   * `submit({ optimistic: island.optimistic((props) => ({ entries: [] })) })`.
   */
  optimistic<R extends object>(patch: ((props: IslandPropsOf<C>) => R) & NoInfer<CheckedPatch<R, IslandPropsOf<C>>>): OptimisticUpdate;
  /** What an action reloads of the island once it succeeded — some props (`only`), all but some (`except`), or all of it. */
  reloading(options?: { only?: readonly (keyof IslandPropsOf<C> & string)[]; except?: readonly (keyof IslandPropsOf<C> & string)[] }): readonly Reloading[];
}

function onServer(): never {
  throw new Error(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? '[marmeon:R14] Actions run in the browser, not while rendering on the server.' : '[marmeon:R14]');
}

/**
 * The island around this component, inside the view an `<Island>` renders. `reload({ query })` is typed by the island route's
 * query schema (`QueryOf<C>`): a wrong field or value is a compile error. See docs/deferred-props.md#inside-an-island.
 */
export function useIsland<C extends IslandAction = IslandAction>(): IslandState<C> {
  const value = useContext(IslandContext);
  if (!value) throw new Error(process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? '[marmeon:R15] useIsland() is for the view of an island — the component an <Island route> renders.' : '[marmeon:R15]');
  return useMemo(
    () =>
      ({
        props: value.snapshot.region?.props ?? {},
        query: value.query,
        status: value.snapshot.status,
        pending: value.snapshot.pending,
        failure: value.snapshot.failure,
        reload: (options?: IslandReloadOptions<C>) => value.reload(options as Parameters<Region['reload']>[0]),
        optimistic: (patch: PropsPatch) => (value.region ? value.region.optimistic(patch) : onServer()),
        reloading: (spec?: ReloadSpec) => (value.region ? [value.region.reloading(spec)] : onServer()),
      }) as unknown as IslandState<C>,
    [value],
  );
}
