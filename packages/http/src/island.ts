import type { CheckViewName } from './page.ts';
import type { ResolvedProps } from './props.ts';
import type { Serialize, ViewProps } from './view.ts';

const ISLAND_RESULT = Symbol.for('bespokecore.island-result');

/**
 * What an island's controller returns (E48): a view of the app and its props, sent as a region object to the
 * `<Island route>` that asked for it — never as a page. Its route is a GET route of its own, with its own middleware,
 * authorization and query schema, reusable on any page.
 */
export interface IslandResult<TProps extends ViewProps = ViewProps, TComponent extends string = string> {
  readonly [ISLAND_RESULT]: true;
  /** The marker the router's types read (`RegionResultMarker`): islands are GET routes, `<Island route>` takes only them. */
  readonly region: 'island';
  readonly component: TComponent;
  readonly props: TProps;
}

/** An island: the view's name — checked against the app's views — and its props. */
export function island<const V extends string, const TProps extends ViewProps>(component: CheckViewName<V>, props: TProps): IslandResult<TProps, V> {
  return { [ISLAND_RESULT]: true, region: 'island', component: component as V, props };
}

export function isIslandResult(value: unknown): value is IslandResult {
  return typeof value === 'object' && value !== null && ISLAND_RESULT in value;
}

type IslandAction = { handle: (...args: never[]) => unknown };

/**
 * The props of an island, from its controller — as they arrive in the browser (resolved and serialized, like
 * `PageProps`), but **without** the shared props: an island is part of a page, which has them (`usePage()`).
 *
 * ```tsx
 * export default function RecentSignIns({ entries }: IslandProps<ShowRecentSignInsController>) { … }
 * ```
 */
export type IslandProps<TAction extends IslandAction> =
  Awaited<ReturnType<TAction['handle']>> extends infer TResult ? (TResult extends IslandResult<infer TProps> ? Serialize<ResolvedProps<TProps>> : never) : never;

/** The view name(s) an island's controller renders. */
export type IslandOf<TAction extends IslandAction> =
  Awaited<ReturnType<TAction['handle']>> extends infer TResult ? (TResult extends IslandResult<ViewProps, infer V> ? V : never) : never;
