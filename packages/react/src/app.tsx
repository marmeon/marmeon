import {
  loadInstant,
  loadPageMessages,
  markBusy,
  Navigator,
  laterTarget,
  loadOptimistic,
  pageLocale,
  prefetchWith,
  RegionOwner,
  TitleRegistry,
  type ConfirmAnswer,
  type ConfirmRequest,
  type Feature,
  type Layer,
  type LayerStack as LayersFeature,
  type OptimisticUpdate,
  type PatchTarget,
  type PrefetchOptions,
  type Reloading,
  type RegionOwner as RegionOwnerType,
  type ProgressIndicator,
  type TitleTemplate,
  type ViewTransitionOption,
  type VisitException,
  type VisitEvent,
  type VisitEvents,
  type VisitOptions,
} from '@bespokecore/http/client';
import { matchesPath, type BrowserRouteNameInput, type CheckIslandRouteName, type PageObject, type PageProps, type RouteManifest, type SharedProps } from '@bespokecore/http/page';
import type { Catalog, MessageLoader } from '@bespokecore/i18n/messages';
import {
  addTransitionType,
  createContext,
  startTransition,
  Suspense,
  use,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { ErrorBoundary, RenderErrorFallback, VisitFailure } from './fallbacks.tsx';
import { ConfirmHost, type ConfirmComponent, type PendingQuestion } from './confirm.tsx';
import { defaultTitle, HeadContext, type HeadCollector } from './head.tsx';
import { I18nContext } from './i18n.tsx';
import type { LayerEntry, LayerFrame } from './layer.tsx';
import { loadView } from './views.ts';
import { layoutsOf, type DefaultLayout, type PageComponent, type ResolvePage } from './pages.ts';
import { RoutesContext } from './routes.ts';
import { SsrContext, StreamedDeferred, type SsrResolvers } from './streamed.tsx';

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

/** The props a patch of page `T` sees — any props when `T` is not given. */
export type PatchedProps<T> = unknown extends T ? Readonly<Record<string, unknown>> : PropsOf<T>;

/**
 * What a patch `(props) => R` of page props `P` must be (E59): the props it changes, from the props shown (the server's, with
 * the patches under way before it), each of its type — a prop the page does not have is named (`'profle' is not a prop of this
 * page`), a value of the wrong type is the usual error, down to the field. It runs again whenever those change: no side effects.
 */
export type CheckedPatch<R, P> = (props: P) => { readonly [K in keyof R]: K extends keyof P ? P[K] : `'${K & string}' is not a prop of this page` };

/**
 * What an action reloads once it succeeded (E59) — some props of the page (`only`), all but some (`except`), its islands of a
 * route (`islands`): `router.reloading({ only: ['profile'] })`. Neither props nor islands: the whole page. What it brings replaces
 * what was there, also a `merge()`d list (a row the action deleted is gone).
 */
export interface ReloadingOptions<T = unknown, I extends readonly string[] = readonly string[]> {
  only?: readonly PropName<T>[];
  except?: readonly PropName<T>[];
  /** The merged props it replaces — default: every prop it brings. `[]` merges them instead (appends, as before Wave 9). */
  reset?: readonly PropName<T>[];
  /** The islands of these routes the page (or layer) shows — each one on screen reloads. Alone: only them, not the page. */
  islands?: { readonly [K in keyof I]: CheckIslandRouteName<I[K] & string> };
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
  /**
   * A patch of this page's props (or the layer's, inside one) for an action or a form (E59) — shown at once, rolled back unless it
   * succeeds: `submit({ optimistic: router.optimistic((props) => ({ likes: props.likes + 1 })) })`. Never in the page's memory
   * before it succeeded, never in `history.state`.
   */
  optimistic<R extends object>(patch: ((props: PatchedProps<T>) => R) & NoInfer<CheckedPatch<R, PatchedProps<T>>>): OptimisticUpdate;
  /** What an action reloads of this page (or layer) once it succeeded — `submit({ reload: router.reloading({ only: ['profile'] }) })`. */
  reloading<const I extends readonly BrowserRouteNameInput[] = []>(options?: ReloadingOptions<T, I>): readonly Reloading[];
}

/**
 * @internal What the hooks read: the page (or the layer) around them and how to navigate from it. A layer brings its own patches
 * and reloads (E59); the page's are its history entry's — `useRouter()` makes them, attaching the optimistic patches on first use.
 */
export interface RouterValue extends Omit<Router, 'optimistic' | 'reloading'>, Partial<Pick<Router, 'optimistic' | 'reloading'>> {
  page: PageObject;
  /** The navigator — null while rendering on the server (for the hooks of this package). */
  navigator(): Navigator | null;
  /** Page components by name — `<Island>` renders its region's view with it. */
  resolve: ResolvePage;
  /** The layer this router is a layer's (E53) — null for the page: what a navigation guard in it belongs to (E64). */
  layer: Layer | null;
}

/**
 * The reloads `reloading()` names: the page's (or layer's) props — unless only islands are named — and every island on screen
 * of the routes named (the routes the browser knows, `<Island route>`).
 */
export function reloadsOf(
  own: (spec: { only?: readonly string[]; except?: readonly string[]; reset?: readonly string[] }) => Reloading,
  owner: RegionOwnerType | null,
  manifest: RouteManifest | undefined,
  { only, except, reset, islands }: { only?: readonly string[]; except?: readonly string[]; reset?: readonly string[]; islands?: readonly string[] } = {},
): readonly Reloading[] {
  const reloads: Reloading[] = [];
  if (!islands || only || except) reloads.push(own({ ...(only ? { only } : {}), ...(except ? { except } : {}), ...(reset ? { reset } : {}) }));
  for (const name of islands ?? []) {
    const route = manifest && Object.hasOwn(manifest, name) ? manifest[name] : undefined;
    if (!route) {
      throw new Error(
        process.env.NODE_ENV !== 'production'
          ? `[bespoke:R8] reloading({ islands: ['${name}'] }): [${name}] is not a route the browser knows — an island reloads where <Island route="${name}"> shows it.`
          : `[bespoke:R8] ${name}`,
      );
    }
    for (const region of owner?.live.values() ?? []) if (matchesPath(route.path, new URL(region.url, 'http://bespoke.invalid').pathname)) reloads.push(region.reloading());
  }
  return reloads;
}

/** The layer stack's module, loading or loaded — marked the way React reads a settled promise (`use()` returns at once). */
type StackModule = Promise<typeof import('./layer-stack.tsx')> & { status?: 'fulfilled'; value?: typeof import('./layer-stack.tsx') };
let stackModule: StackModule | undefined;

/**
 * @internal The layer stack (E53, E71) — a chunk of its own, with the core's layers: loaded once per app, asked for again when
 * it failed. Loaded before a render with layers (and before hydrating a deep link), so the stack renders at once.
 */
export function loadLayerStack(): Promise<typeof import('./layer-stack.tsx')> {
  if (!stackModule) {
    const loading: StackModule = import('./layer-stack.tsx');
    loading.then(
      (module) => void Object.assign(loading, { status: 'fulfilled', value: module }),
      () => void (stackModule = undefined),
    );
    stackModule = loading;
  }
  return stackModule;
}

/** @internal How the app's navigator loads the layers (E71): with the stack that renders them — one round trip. */
export const loadLayers = (): Promise<Feature<LayersFeature>> => loadLayerStack().then((module) => module.layers);

/** The layers over the page, rendered by the stack — loaded already: never suspends (but would, inside its boundary). */
function Layers(props: { entries: readonly LayerEntry[]; resolve: ResolvePage; frame: LayerFrame | undefined; base: RouterValue }) {
  const { LayerStack } = use(loadLayerStack());
  return <LayerStack {...props} />;
}

/** One id per layer object — a layer replaced by a fresh one (another state) mounts anew, even in the same entry. */
const layerIds = new WeakMap<Layer, string>();
let nextLayerId = 0;

/** A layer of the core, as the stack renders it. */
function entryOf(layer: Layer): LayerEntry {
  let id = layerIds.get(layer);
  if (id === undefined) layerIds.set(layer, (id = `layer-${++nextLayerId}`));
  return { id, layer, page: layer.view, depth: layer.depth };
}

/** The page object without the layers a deep link brought (they render over it). */
function withoutLayers(page: PageObject): PageObject {
  if (!page.layers) return page;
  const { layers: _layers, ...rest } = page;
  return rest;
}

/** The regions (islands) of the page on screen — its history entry's (null on the server: islands load in the browser). */
export const RegionOwnerContext = createContext<RegionOwner | null>(null);

/** @internal A layer provides its own (E53): `usePage`, `useRouter` and `useForm` inside it act as the layer. */
export const RouterContext = createContext<RouterValue | null>(null);

export function useRouterContext(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error(process.env.NODE_ENV !== 'production' ? '[bespoke:R9] BespokeCore hooks must be used inside <BespokeApp>.' : '[bespoke:R9]');
  return value;
}

/**
 * A feature of the client core (E73) — what an adapter component uses of it, `useFeature(islands).region(…)` (Wave 5c step 4):
 * attached to the app's navigator on first use, once per navigator (E70; `navigator.use`). In the browser only — there is no
 * navigator while rendering on the server.
 */
export function useFeature<API>(feature: Feature<API>): API {
  const navigator = useRouterContext().navigator();
  if (!navigator) {
    throw new Error(
      process.env.NODE_ENV !== 'production'
        ? `[bespoke:R10] useFeature(${feature.name}): the ${feature.name} feature runs in the browser — there is no navigator while rendering on the server. Use it in a component that renders in the browser only.`
        : `[bespoke:R10] ${feature.name}`,
    );
  }
  return navigator.use(feature);
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
  const { visit, reload, prefetch, on, optimistic: own, reloading: ownReloading, navigator } = useRouterContext();
  const routes = useContext(RoutesContext);
  // The page's patches and reloads are those of its history entry (E59) — never in its props in memory. The optimistic patches
  // attach on first use (E70): an app that never patches the page carries none of their code (a layer brings its own).
  const optimistic = useCallback(
    (patch: (props: Readonly<Record<string, unknown>>) => object) => (own ? own(patch as never) : { target: pagePatches(navigator()), patch: patch as never }),
    [own, navigator],
  );
  const reloading = useCallback(
    (options?: ReloadingOptions) =>
      ownReloading ? ownReloading(options as never) : reloadsOf((spec) => ({ target: pagePatches(navigator()), spec }), navigator()?.regionOwner ?? null, routes, options as Parameters<typeof reloadsOf>[3]),
    [ownReloading, navigator, routes],
  );
  return useMemo(() => ({ visit, reload, prefetch, on, optimistic, reloading }) as Router<T>, [visit, reload, prefetch, on, optimistic, reloading]);
}

/**
 * The optimistic patches of the page on screen — its history entry's (E59). Their code loads with the first use (a chunk of its
 * own): until it is there, a target that does what is asked of it once it is.
 */
function pagePatches(navigator: Navigator | null): PatchTarget {
  if (!navigator) throw new Error(process.env.NODE_ENV !== 'production' ? '[bespoke:R11] Visits run in the browser, not while rendering on the server.' : '[bespoke:R11]');
  const loaded = navigator.loaded(loadOptimistic);
  const key = navigator.regionOwner.entry!;
  return loaded ? loaded.target(key) : laterTarget(navigator.load(loadOptimistic).then((feature) => feature.target(key)));
}

/** What `progress` took before E82 (`{ delay }`, `false`), as a type error that says what to write now. */
type ProgressHint = "progress takes an indicator since E82 — progress: progressBar({ delay: 250 }), import { progressBar } from '@bespokecore/react'; leave it out for none";
type ProgressBefore = { readonly delay?: ProgressHint; readonly color?: ProgressHint };

/**
 * @internal The app's progress indicator (E82) — none by default. What `progress` took before (`{ delay }`, `false`) says what to
 * import now.
 */
export function progressIndicator(progress: BespokeAppProps['progress'] | unknown): ProgressIndicator | undefined {
  if (progress === undefined) return undefined;
  if (typeof progress === 'function') return progress as ProgressIndicator;
  throw new TypeError(
    process.env.NODE_ENV !== 'production'
      ? `[bespoke:R16] progress takes an indicator since E82: createBespokeApp({ progress: progressBar({ delay: 250 }) }) — import { progressBar } from '@bespokecore/react'. Leave it out for no progress bar.`
      : '[bespoke:R16]',
  );
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
  /**
   * An indicator of visits under way (E82, opt-in): `progressBar({ delay: 250 })` — the core's bar, shown only for visits slower
   * than `delay` — or the app's own (`(navigator) => stop`). None by default: `aria-busy` on `<html>`, `data-pending` on links and
   * `usePending()` are there either way.
   */
  progress?: ProgressIndicator | ProgressBefore | ProgressHint;
  /** Server rendering only: where `<Head>` records itself. */
  headCollector?: HeadCollector;
  /**
   * The app's language files (`createMessageLoader(lang)` of @bespokecore/i18n/messages) — each page renders with the
   * messages of its `locale`, loaded before it renders (`useTranslation`). Without them, `useTranslation` throws.
   */
  messages?: MessageLoader;
  /** The first page's messages, loaded before hydrating (by `createBespokeApp` and the SSR entry). */
  initialCatalog?: Catalog;
  /** Server rendering only (E49): islands and deferred groups, resolved in-process by the page's request (the SSR entry). */
  ssr?: SsrResolvers;
  /** The frame around every layer's view (E53) — default `LayerDialog`, a native modal `<dialog>`. A view's own `layer` wins. */
  layer?: LayerFrame;
  /**
   * The dialog that asks the user (E64): a link's, an action's or a form's `confirm`, and the navigation guard's question —
   * `ConfirmDialog`, or the app's own. Default: the browser's `confirm()` (and `prompt()` for a text to type).
   */
  confirm?: ConfirmComponent;
  /** Client features attached from the start (`NavigatorOptions.features`) — `createBespokeApp` passes tab sync (E149). */
  features?: readonly Feature[] | undefined;
  /**
   * View transitions for every page change (E185) — `true` (or `{ types }`): the core's, `document.startViewTransition` around each
   * page swap (the browser crossfades the page). `'react'`: React's — each page change renders in `startTransition` with its types
   * (`addTransitionType`), and the `<ViewTransition>` components of the views animate; React starts the transition, the core never does.
   */
  viewTransition?: ViewTransitionOption | 'react' | undefined;
}

interface Current {
  page: PageObject;
  Component: PageComponent;
  /** The page's messages (in its locale). */
  catalog: Catalog | undefined;
  /** Changes remount the page component (fresh state); an unchanged key preserves it. */
  key: number;
  /** Where the page's islands live — from the navigator with each page (undefined for the first: the navigator's current). */
  owner?: RegionOwner;
  /**
   * An instant visit's placeholder (E64) in the page's place — the target view's `placeholder`, with what the link gave it,
   * inside that view's layouts. The page (the context `usePage()` reads) is still the one before.
   */
  placeholder?: { readonly Component: ComponentType<any>; readonly View: PageComponent; readonly name: string; readonly props: Readonly<Record<string, unknown>> };
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
  ssr,
  layer: frame,
  confirm: Confirm,
  features,
  viewTransition,
}: BespokeAppProps) {
  // A deep link's document brings the layers over its page (E53): rendered over it, apart from it.
  const firstPage = useMemo(() => withoutLayers(initialPage), [initialPage]);
  const [current, setCurrent] = useState<Current>({ page: firstPage, Component: initialComponent, catalog: initialCatalog, key: 0 });
  const [failure, setFailure] = useState<VisitException | null>(null);

  // The navigator waits until a page is on screen before it restores the scroll position.
  const committed = useRef<(() => void)[]>([]);

  // Renders in order of the calls: a placeholder that resolves after a later render started is dropped (E64).
  const renders = useRef(0);
  const render = useCallback(
    async (
      page: PageObject,
      { preserveState, owner, layers, placeholder, transition }: { preserveState: boolean; owner: RegionOwner; layers: readonly Layer[]; placeholder?: boolean; transition?: readonly string[] },
    ) => {
      const turn = ++renders.current;
      if (placeholder) {
        // An instant visit (E64): the target view's placeholder — never the view itself, with props it does not have yet.
        const View = await resolve(page.component);
        const Placeholder = View.placeholder;
        if (!Placeholder || renders.current !== turn) return;
        await new Promise<void>((done) => {
          committed.current.push(done);
          setCurrent((previous) => ({ ...previous, placeholder: { Component: Placeholder, View, name: page.component, props: page.props } }));
        });
        return;
      }
      // The page's component and its locale's messages, both before it renders: a page in another language (another
      // tab switched it) loads that language's files first. The layers' views too — they show at once.
      const [Component, catalog] = await Promise.all([
        resolve(page.component),
        loadPageMessages(page, messages),
        ...(layers.length > 0 ? [loadLayerStack(), ...layers.map((layer) => loadView(resolve, layer.page.component))] : []),
      ]);
      await new Promise<void>((done) => {
        committed.current.push(done);
        // A view transition by React (E185, `viewTransition: 'react'`): the page changes in a transition with its types — the views'
        // <ViewTransition> animate. Resolved, as any render, once it is committed (the layout effect below).
        (transition ? startTransition : (swap: () => void) => swap())(() => {
          transition?.forEach((type) => addTransitionType(type));
          // Only the layers changed: the page stays exactly as it is (no render of it, nothing above it changes).
          setCurrent((previous) =>
            previous.page === page && previous.owner === owner && preserveState && !previous.placeholder
              ? previous
              : { page, Component, catalog, key: preserveState && previous.Component === Component && !previous.placeholder ? previous.key : previous.key + 1, owner },
          );
          setLayers(layers.map(entryOf));
        });
      });
    },
    [resolve, messages],
  );
  const renderRef = useRef(render);
  renderRef.current = render;

  // One navigator per app, in the browser only (the server renders a single page). Created during the first
  // render, so a page's own effects — which run before this component's — can already visit.
  // Questions for the app's confirmation dialog (E64), one at a time.
  const [questions, setQuestions] = useState<readonly PendingQuestion[]>([]);
  const nextQuestion = useRef(0);
  const ask = useCallback(
    (request: ConfirmRequest) =>
      new Promise<ConfirmAnswer>((resolve) => {
        const id = ++nextQuestion.current;
        const question: PendingQuestion = {
          id,
          request,
          resolve: (answer) => {
            setQuestions((current) => current.filter((pending) => pending.id !== id));
            resolve(answer);
          },
        };
        setQuestions((current) => [...current, question]);
      }),
    [],
  );
  const navigator = useRef<Navigator | null>(null);
  if (navigator.current === null && typeof window !== 'undefined') {
    navigator.current = new Navigator({
      initialPage,
      render: (page, options) => renderRef.current(page, options),
      // What a view declares to reload when Back/Forward shows it from memory (E58): `Show.revalidateOnBack = ['activity']`.
      revalidateOnBack: async (component) => (await resolve(component)).revalidateOnBack,
      // The app's dialog asks (E64) — without one, the browser's own.
      ...(Confirm ? { confirm: ask } : {}),
      // The layers load with the stack that renders them (E71).
      loadLayers,
      // What the app attaches from the start: tab sync (E149), before the navigator takes over the history.
      features,
      // View transitions (E185): the core's, or React's (the core hands the types to `render`).
      viewTransition,
    });
    // A deep link's layers: their code was loaded before hydrating (createBespokeApp) — attached before the navigator stacks them.
    if (stackModule?.value) navigator.current.use(stackModule.value.layers);
    // What the views use (E70): `revalidateOnBack` with the pages of `resolveModulePages`.
    for (const feature of resolve.features ?? []) navigator.current.use(feature);
  }
  // The layers on screen — the core's in the browser; on the server, the deep link's page objects.
  const [layers, setLayers] = useState<readonly LayerEntry[]>(() =>
    navigator.current
      ? navigator.current.layers.map(entryOf)
      : (initialPage.layers ?? []).map((page, index) => ({ id: `layer-${index}`, layer: null, page, depth: index + 1 })),
  );
  useLayoutEffect(() => {
    for (const done of committed.current.splice(0)) done();
  }, [current, layers]);
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
    const indicator = progressIndicator(progress);
    if (indicator) stops.push(indicator(nav));
    // `aria-busy` on the document while a visit runs (E64).
    if (typeof document !== 'undefined') stops.push(markBusy(nav));
    return () => {
      for (const stop of stops) stop();
    };
    // The progress indicator is read once — like the navigator itself.
  }, []);

  const browser = useCallback(() => {
    if (!navigator.current) throw new Error(process.env.NODE_ENV !== 'production' ? '[bespoke:R11] Visits run in the browser, not while rendering on the server.' : '[bespoke:R11]');
    return navigator.current;
  }, []);
  const visit = useCallback(
    (url: string, options?: VisitOptions) => {
      const nav = browser();
      // An instant visit (E64) needs the instant code (E74): `<Link instant>` loads it when it renders. A visit before it is here
      // goes without its placeholder.
      if (options?.instant) nav.load(loadInstant).catch(() => undefined);
      return nav.visit(url, options);
    },
    [browser],
  );
  const reload = useCallback((options?: ReloadOptions) => browser().reload(options), [browser]);
  // A prefetch while rendering on the server (an effect never runs there) has nothing to do. Its code loads with the first (E74).
  const prefetch = useCallback((url: string, options?: PrefetchOptions) => (navigator.current ? prefetchWith(navigator.current, url, options) : Promise.resolve()), []);
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
    () => ({ page: current.page, visit, reload, prefetch, on, navigator: getNavigator, resolve, layer: null }) as RouterValue,
    [current.page, visit, reload, prefetch, on, getNavigator, resolve],
  );
  const { Component, page, key, catalog, placeholder } = current;
  const owner = current.owner ?? navigator.current?.regionOwner ?? null;

  const locale = messages ? pageLocale(page, messages) : page.locale;
  const i18n = useMemo(() => (catalog && locale ? { catalog, locale } : null), [catalog, locale]);
  // The document's language follows the page's (the server set it for the first one).
  useEffect(() => {
    if (locale && typeof document !== 'undefined' && document.documentElement.lang !== locale) document.documentElement.lang = locale;
  }, [locale]);

  const titles = useMemo(() => (typeof document === 'undefined' ? undefined : new TitleRegistry(title)), [title]);
  const head = useMemo(() => ({ template: title, collector: headCollector, titles }), [title, headCollector, titles]);

  const content = placeholder ? (
    // An instant visit's placeholder (E64): what the link gave it — the real view renders only with its page.
    <ErrorBoundary resetKey={placeholder} fallback={() => null}>
      <placeholder.Component {...placeholder.props} />
    </ErrorBoundary>
  ) : (
    <ErrorBoundary resetKey={page} onError={() => onPageError(page)} onRendered={() => onPageRendered(page)} fallback={(error) => <RenderErrorFallback resolve={resolve} error={error} />}>
      <Component key={key} {...page.props} />
    </ErrorBoundary>
  );
  // Same layout at the same depth → the same element type in the same place: React keeps it mounted (the placeholder's too).
  const tree = (placeholder ? layoutsOf(placeholder.View, placeholder.name, layout) : layoutsOf(Component, page.component, layout)).reduceRight<ReactNode>(
    (children, Layout) => <Layout>{children}</Layout>,
    content,
  );

  return (
    <SsrContext.Provider value={ssr ?? null}>
      <HeadContext.Provider value={head}>
        <RoutesContext.Provider value={routes}>
          <I18nContext.Provider value={i18n}>
            <RouterContext.Provider value={router}>
              <RegionOwnerContext.Provider value={owner}>
                {/* A layout that throws takes the whole page down — to the error page, without layouts. */}
                <ErrorBoundary resetKey={page} fallback={(error) => <RenderErrorFallback resolve={resolve} error={error} />}>
                  {tree}
                </ErrorBoundary>
              </RegionOwnerContext.Provider>
              {/* The layers over the page (E53) — apart from it: opening one changes nothing the page renders from. */}
              {layers.length > 0 && (
                <Suspense fallback={null}>
                  <Layers entries={layers} resolve={resolve} frame={frame} base={router} />
                </Suspense>
              )}
              <VisitFailure failure={failure} resolve={resolve} onDismiss={() => setFailure(null)} />
              {/* The question a link, an action, a form or the navigation guard asks (E64) — over everything, one at a time. */}
              <ConfirmHost questions={questions} component={Confirm} />
              {/* The first page's deferred groups the server streams with the document (E49): to the navigator as they arrive. */}
              <StreamedDeferred groups={initialPage.streamedProps} navigator={getNavigator} />
            </RouterContext.Provider>
          </I18nContext.Provider>
        </RoutesContext.Provider>
      </HeadContext.Provider>
    </SsrContext.Provider>
  );
}
