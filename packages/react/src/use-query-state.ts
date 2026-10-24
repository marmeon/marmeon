import { assertQueryPage, type QueryState } from '@marmeon/http/client/adapter';
import { resolveRoute, type QueryStateOptions, type QueryUpdate } from '@marmeon/http/client';
import { pageQueryOf } from '@marmeon/http/client/adapter';
import { queryState } from '@marmeon/http/client/adapter';
import type { BrowserRouteNameInput, CheckBrowserRouteName, ControllerOf, Routes, RouteQueryOf } from '@marmeon/http/page';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useRouterContext, type PartialReloadOptions } from './app.tsx';
import { RoutesContext } from './routes.ts';

type Instance<C> = C extends abstract new (...args: never) => infer I ? I : never;

/** A browser route whose controller has a query schema — the state's fields come from it. (Any name while no routes are generated.) */
type CheckQueryRoute<N extends string> =
  CheckBrowserRouteName<N> extends N
    ? N extends keyof Routes
      ? [RouteQueryOf<N>] extends [never]
        ? `'${N}' has no query schema to keep state in — give its controller \`static request = defineRequest({ query })\``
        : N
      : N
    : CheckBrowserRouteName<N>;

/** The state of route `N`: its parsed query, defaults filled in (any fields while no routes are generated). */
type QueryStateOf<N extends string> = [RouteQueryOf<N>] extends [never] ? Record<string, unknown> : RouteQueryOf<N>;

/** Options of {@link useQueryState} — `only`/`except`/`reset` checked against the props of the route's page. */
export type UseQueryStateOptions<N extends string = string> = Omit<QueryStateOptions, 'only' | 'except' | 'reset'> &
  PartialReloadOptions<Instance<ControllerOf<N>>>;

/**
 * Sets the state: some fields (`undefined` → back to the default) or a function of the current state. (One signature,
 * not two overloads: a wrong value then reads "Did you mean '"name"'?" instead of "No overload matches this call".)
 */
export type SetQueryState<Q> = (update: QueryUpdate<Q>) => void;

/**
 * Typed URL state: the page's query as its controller's `query` schema parsed it, and a setter that changes the URL with a
 * visit of the same page (partial with `only`, keeping component state and scroll). The state changes at once, the URL after
 * `debounce` ms. Only on the page of route `name`; a route without a query schema is a compile error.
 * See docs/pagination.md#searching-and-sorting.
 */
export function useQueryState<const N extends BrowserRouteNameInput>(
  name: CheckQueryRoute<N>,
  options: UseQueryStateOptions<N> = {},
): [QueryStateOf<N>, SetQueryState<QueryStateOf<N>>] {
  const router = useRouterContext();
  const manifest = useContext(RoutesContext);
  const { page } = router;
  resolveRoute(manifest, name); // a name the manifest lacks throws the usual message
  assertQueryPage(name, manifest![name]!.path, page);

  const latest = useRef(options);
  latest.current = options;
  const state = useRef<QueryState | null>(null);
  // What was set before the state existed (a child's effect runs before this hook's): set once it does — never dropped.
  const early = useRef<QueryUpdate<Record<string, unknown>>[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown> | undefined>(undefined);
  useEffect(() => {
    const navigator = router.navigator();
    if (!navigator) return undefined;
    // The feature attaches on first use — an app without query state carries none of it.
    const current = navigator.use(queryState).create(latest.current as QueryStateOptions, router.layer ?? undefined);
    state.current = current;
    const stop = current.subscribe(() => setDraft(current.draft));
    for (const update of early.current.splice(0)) current.set(update);
    return () => {
      stop();
      current.dispose();
      if (state.current === current) state.current = null;
    };
  }, []);
  if (state.current) state.current.options = options as QueryStateOptions;

  const set = useCallback((update: QueryUpdate<Record<string, unknown>>) => {
    if (state.current) state.current.set(update);
    else early.current.push(update);
  }, []) as SetQueryState<QueryStateOf<N>>;
  return [(draft ?? pageQueryOf(page)) as QueryStateOf<N>, set];
}
