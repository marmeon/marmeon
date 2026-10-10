/**
 * Typed URL state as a feature: the query state of the page on screen — `navigator.use(queryState).create(options)`,
 * what an adapter's `useQueryState` builds on. It keeps nothing of the server's: the draft is what is being typed, the
 * page on screen is the navigator's.
 */
import { defineFeature } from '../feature.ts';
import { QueryState, type QueryStateOptions } from '../query-state.ts';

/** What adapters use of query state: one per component that shows it. */
export interface QueryStateFeature {
  /** The query state of the page on screen — `dispose()` it when the component goes. */
  create<Q extends Record<string, unknown> = Record<string, unknown>>(options?: QueryStateOptions): QueryState<Q>;
}

/** Typed URL state: `navigator.use(queryState).create({ only: ['people'], debounce: 300 })`. */
export const queryState = defineFeature('queryState', (host): QueryStateFeature => ({ create: (options) => new QueryState(host.navigator, options) }));
