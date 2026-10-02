/**
 * Page props that are more than a value (E7, Inertia's semantics): left out of the first response, loaded after
 * it, sent with every partial reload, or merged into what the browser already has.
 *
 * ```ts
 * return this.view('user-profile/Show', {
 *   profile,
 *   stats: optional(() => this.#stats.for(profile.id)),   // only when asked for: reload({ only: ['stats'] })
 *   activity: defer(() => this.#activity.for(profile.id)), // the page renders without it; the browser loads it next
 *   links: merge(page.data),                               // a partial reload appends to the links shown
 * });
 * ```
 *
 * A plain function is a prop, too — evaluated only when the response includes it (a partial reload that asks for
 * other props never calls it).
 */
const PROP = Symbol.for('bespokecore.page-prop');

/** Carries a prop's type (never set at runtime). */
declare const TYPE: unique symbol;

export type PropKind = 'optional' | 'defer' | 'always' | 'merge' | 'deepMerge' | 'once';

interface PageProp<K extends PropKind, T> {
  readonly [PROP]: K;
  readonly [TYPE]?: T;
}

/** A value, or a function that computes it (evaluated only when the response includes the prop). */
type Lazy<T> = T | (() => T | PromiseLike<T>);

/** `() => R` → the awaited `R`; anything else stays. */
type Unlazy<V> = V extends () => infer R ? Awaited<R> : V;

/** Never in a full response — only when a partial reload names it (`only`). In the view: `T | undefined`. */
export interface OptionalProp<T> extends PageProp<'optional', T> {
  readonly resolve: () => unknown;
}

/** Not in the first response: the browser loads its `group` right after showing the page. In the view: `T | undefined`. */
export interface DeferredProp<T> extends PageProp<'defer', T> {
  readonly group: string;
  readonly resolve: () => unknown;
  /** Once loaded, a partial reload of it (a poll, "load more") is merged into what the browser has — see {@link merge}. */
  merge(): MergingDeferredProp<T, 'merge'>;
  /** As {@link DeferredProp.merge}, all the way down — see {@link deepMerge}. */
  deepMerge(): MergingDeferredProp<T, 'deepMerge'>;
}

/** In every response — also in partial reloads that ask for other props. */
export interface AlwaysProp<T> extends PageProp<'always', T> {
  readonly value: unknown;
}

/** How a partial reload merges a prop into the browser's: arrays appended, objects one level (`merge`) or all the way (`deepMerge`). */
export type MergeStrategy = 'merge' | 'deepMerge';

/** Merged into the value the browser has on a partial reload — arrays appended, objects shallowly merged. */
export interface MergeProp<T, S extends MergeStrategy = MergeStrategy> extends PageProp<S, T> {
  readonly value: unknown;
  /** Keys that identify an item of a merged array (`matchOn`). */
  readonly match: readonly string[];
  /**
   * Items of the merged array with the same value of `key` replace each other instead of appearing twice — the
   * same page loaded again (a poll, a double click on "load more"): `merge(people).matchOn('id')`, or for a list
   * inside an object, `deepMerge({ data, meta }).matchOn('data.id')`.
   */
  matchOn(...keys: MatchKey<T, S>[]): MergeProp<T, S>;
}

/**
 * Where a merged prop's array items carry their identity: a key of the items of an array prop (`merge`), or, for
 * `deepMerge`, the path to a key of the items of an array inside it (`'data.id'` of `{ data: User[] }`).
 */
export type MatchKey<T, S extends MergeStrategy> = S extends 'deepMerge' ? DeepItemKey<T, []> : ItemKey<T>;

type ItemKey<T> = T extends readonly (infer E)[] ? (E extends object ? keyof E & string : never) : never;

type DeepItemKey<T, Depth extends unknown[]> = Depth['length'] extends 4
  ? never
  : T extends readonly unknown[]
    ? ItemKey<T>
    : T extends Date | ((...args: never) => unknown)
      ? never
      : T extends object
        ? { [K in keyof T & string]: `${K}.${DeepItemKey<T[K], [...Depth, unknown]>}` }[keyof T & string]
        : never;

/**
 * Computed once per browser tab (E64): sent with the first page that has it, then kept by the browser — the server skips it
 * while the browser says it holds it (under the same session). In the view: `T`.
 */
export interface OnceProp<T> extends PageProp<'once', T> {
  readonly resolve: () => unknown;
  /** Where the browser keeps it — undefined: the prop's name (a shared prop) or `<view>:<prop>` (a page's own). */
  readonly key: string | undefined;
  /** How long the browser may keep it, in ms — undefined: for the life of the document (until a full load). */
  readonly ttl: number | undefined;
}

/** Any wrapped prop. */
export type WrappedProp<T = unknown> = OptionalProp<T> | DeferredProp<T> | MergingDeferredProp<T> | AlwaysProp<T> | MergeProp<T> | OnceProp<T>;

/**
 * A prop the page gets only when it asks: `reload({ only: ['stats'] })`. Never computed for a full response —
 * for data that is expensive and rarely looked at.
 */
export function optional<R>(resolve: () => R): OptionalProp<Awaited<R>> {
  return { [PROP]: 'optional', resolve } as OptionalProp<Awaited<R>>;
}

/** A deferred prop that is merged into what the browser has when it is loaded again — `defer(fn).merge()`. */
export interface MergingDeferredProp<T, S extends MergeStrategy = MergeStrategy> extends PageProp<'defer', T> {
  readonly group: string;
  readonly resolve: () => unknown;
  readonly strategy: S;
  readonly match: readonly string[];
  /** As {@link MergeProp.matchOn}. */
  matchOn(...keys: MatchKey<T, S>[]): MergingDeferredProp<T, S>;
}

/**
 * A prop the page renders without: the first response leaves it out (and names it in `deferredProps`), the browser
 * fetches it right after showing the page — props of one `group` in one request, groups in parallel.
 * `defer(fn).merge()` / `.deepMerge()`: once loaded, partial reloads of it ("load more") merge into it.
 */
export function defer<R>(resolve: () => R, group = 'default'): DeferredProp<Awaited<R>> {
  const merging = (strategy: MergeStrategy, match: readonly string[]): MergingDeferredProp<Awaited<R>> =>
    ({ [PROP]: 'defer', group, resolve, strategy, match, matchOn: (...keys: string[]) => merging(strategy, [...match, ...keys]) }) as MergingDeferredProp<Awaited<R>>;
  return {
    [PROP]: 'defer',
    group,
    resolve,
    merge: () => merging('merge', []),
    deepMerge: () => merging('deepMerge', []),
  } as unknown as DeferredProp<Awaited<R>>;
}

/** Where and how long the browser keeps a once prop. */
export interface OnceOptions {
  /**
   * The key the browser keeps it under — the same key on several views shares one value: `once(fn, { key: 'countries' })`.
   * Default: the prop's name for a shared prop (the app's: every page), `<view>:<prop>` for a page's own.
   */
  readonly key?: string;
  /** How long it may be kept, in ms (by the server's clock) — then sent again. Default: as long as the document lives. */
  readonly ttl?: number;
}

/** Values JSON keeps as they are — what a once prop may hold (the browser keeps it as it arrived, and uses it for every page). */
type Unstorable = undefined | symbol | bigint | ((...args: never[]) => unknown) | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | WeakMap<object, unknown> | WeakSet<object> | Promise<unknown>;

/** The first part of `T` that JSON cannot carry, or `never` when it all can. */
type UnstorablePart<T, Depth extends unknown[] = []> = Depth['length'] extends 6
  ? never
  : T extends Unstorable
    ? T
    : T extends string | number | boolean | null | Date
      ? never
      : T extends readonly (infer E)[]
        ? UnstorablePart<E, [...Depth, 0]>
        : T extends object
          ? { [K in keyof T]-?: UnstorablePart<T[K], [...Depth, 0]> }[keyof T]
          : never;

/** `unknown` for a value a once prop may hold — else the message (the return of `once(() => …)` is checked against it). */
export type CheckOnceValue<T> = [UnstorablePart<T>] extends [never]
  ? unknown
  : 'a once prop is kept by the browser as JSON — its value must be plain data (no functions, Map, Set, bigint, undefined or promises inside)';

/**
 * A prop the browser keeps (E64, Inertia's `once()`): computed for the first page that has it, then — while the browser holds
 * it, in memory, for this tab — never again: the client says what it holds (`x-bespoke-once`), the server skips it. For data
 * that is the same on every page and expensive or large: a country list, the supported locales, translations.
 *
 * ```ts
 * share('locales', once(() => this.#locales.supported));                 // the app's: one value for every page
 * countries: once(() => this.#countries.all(), { key: 'countries' }),    // shared by every view that names the key
 * ```
 *
 * Held only by the document: a full load (sign-in or sign-out — the session changes —, a new build, a language switch, a
 * reload) starts over. And only for the session it was sent to (`PageObject.onceScope`): another tab signing someone else in
 * makes the server send it again. Never for something per user that changes while the page is open — that is a normal prop.
 */
export function once<R>(resolve: () => R & CheckOnceValue<Awaited<R>>, options: OnceOptions = {}): OnceProp<Awaited<R>> {
  return { [PROP]: 'once', resolve, key: options.key, ttl: options.ttl } as unknown as OnceProp<Awaited<R>>;
}

/** A prop sent with every response, partial reloads included (the shared `errors` are one). */
export function always<V>(value: V): AlwaysProp<Unlazy<V>> {
  return { [PROP]: 'always', value } as AlwaysProp<Unlazy<V>>;
}

function mergeProp(kind: MergeStrategy, value: unknown, match: readonly string[]): MergeProp<unknown> {
  return { [PROP]: kind, value, match, matchOn: (...keys: string[]) => mergeProp(kind, value, [...match, ...keys]) } as unknown as MergeProp<unknown>;
}

/**
 * A prop a partial reload merges into what the browser already shows — arrays are appended, objects merged one
 * level deep: `links: merge(page.data)` for "load more". A full response replaces it as usual. `.matchOn('id')`
 * keeps an item from appearing twice.
 */
export function merge<V>(value: V): MergeProp<Unlazy<V>, 'merge'> {
  return mergeProp('merge', value, []) as MergeProp<Unlazy<V>, 'merge'>;
}

/** Like {@link merge}, but all the way down: nested objects are merged, nested arrays appended. */
export function deepMerge<V>(value: V): MergeProp<Unlazy<V>, 'deepMerge'> {
  return mergeProp('deepMerge', value, []) as MergeProp<Unlazy<V>, 'deepMerge'>;
}

/** How a sent prop is merged by the browser (and on which keys), or undefined when it replaces. */
export function mergeOf(value: unknown): { strategy: MergeStrategy; match: readonly string[] } | undefined {
  const kind = propKind(value);
  if (kind === 'merge' || kind === 'deepMerge') return { strategy: kind, match: (value as MergeProp<unknown>).match };
  if (kind === 'defer' && 'strategy' in (value as object)) {
    const { strategy, match } = value as MergingDeferredProp<unknown>;
    return { strategy, match };
  }
  return undefined;
}

/** What kind of wrapped prop `value` is — undefined for a plain value (or a function). */
export function propKind(value: unknown): PropKind | undefined {
  return typeof value === 'object' && value !== null && PROP in value ? (value as PageProp<PropKind, unknown>)[PROP] : undefined;
}

/** The value of a prop, computed now: wrappers unwrapped, functions called, promises awaited. */
export async function resolveProp(value: unknown): Promise<unknown> {
  switch (propKind(value)) {
    case 'optional':
    case 'defer':
    case 'once':
      return (value as OptionalProp<unknown>).resolve();
    case 'always':
    case 'merge':
    case 'deepMerge':
      return unlazy((value as AlwaysProp<unknown>).value);
    default:
      return unlazy(value);
  }
}

function unlazy(value: unknown): unknown {
  return typeof value === 'function' ? (value as () => unknown)() : value;
}

/** A prop as the view receives it (before serialization): wrappers unwrapped, `optional`/`defer` possibly missing. */
export type ResolvedProp<V> =
  V extends PageProp<infer K, infer T> ? (K extends 'optional' | 'defer' ? T | undefined : T) : V extends () => infer R ? Awaited<R> : V;

/** All props of a view, as the view receives them (before serialization). */
export type ResolvedProps<P> = { [K in keyof P]: ResolvedProp<P[K]> };

/** What `SharedData.share()` takes for a shared prop of type `T`. */
export type SharedValue<T> =
  | Lazy<T>
  | AlwaysProp<T>
  | MergeProp<T>
  | OnceProp<T>
  | (undefined extends T
      ? OptionalProp<Exclude<T, undefined>> | DeferredProp<Exclude<T, undefined>> | MergingDeferredProp<Exclude<T, undefined>>
      : NotOptional);

/** In place of `optional()`/`defer()` for a shared prop that is always there — the property name is the message. */
interface NotOptional {
  readonly [PROP]: 'optional' | 'defer';
  readonly 'optional() and defer() make a shared prop possibly missing: declare it as `T | undefined` in SharedProps': true;
}
