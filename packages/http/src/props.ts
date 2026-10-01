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

export type PropKind = 'optional' | 'defer' | 'always' | 'merge' | 'deepMerge';

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
}

/** In every response — also in partial reloads that ask for other props. */
export interface AlwaysProp<T> extends PageProp<'always', T> {
  readonly value: unknown;
}

/** Merged into the value the browser has on a partial reload — arrays appended, objects shallowly merged. */
export interface MergeProp<T> extends PageProp<'merge' | 'deepMerge', T> {
  readonly value: unknown;
}

/** Any wrapped prop. */
export type WrappedProp<T = unknown> = OptionalProp<T> | DeferredProp<T> | AlwaysProp<T> | MergeProp<T>;

/**
 * A prop the page gets only when it asks: `reload({ only: ['stats'] })`. Never computed for a full response —
 * for data that is expensive and rarely looked at.
 */
export function optional<R>(resolve: () => R): OptionalProp<Awaited<R>> {
  return { [PROP]: 'optional', resolve } as OptionalProp<Awaited<R>>;
}

/**
 * A prop the page renders without: the first response leaves it out (and names it in `deferredProps`), the browser
 * fetches it right after showing the page — props of one `group` in one request, groups in parallel.
 */
export function defer<R>(resolve: () => R, group = 'default'): DeferredProp<Awaited<R>> {
  return { [PROP]: 'defer', group, resolve } as DeferredProp<Awaited<R>>;
}

/** A prop sent with every response, partial reloads included (the shared `errors` are one). */
export function always<V>(value: V): AlwaysProp<Unlazy<V>> {
  return { [PROP]: 'always', value } as AlwaysProp<Unlazy<V>>;
}

/**
 * A prop a partial reload merges into what the browser already shows — arrays are appended, objects merged one
 * level deep: `links: merge(page.data)` for "load more". A full response replaces it as usual.
 */
export function merge<V>(value: V): MergeProp<Unlazy<V>> {
  return { [PROP]: 'merge', value } as MergeProp<Unlazy<V>>;
}

/** Like {@link merge}, but all the way down: nested objects are merged, nested arrays appended. */
export function deepMerge<V>(value: V): MergeProp<Unlazy<V>> {
  return { [PROP]: 'deepMerge', value } as MergeProp<Unlazy<V>>;
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
  | (undefined extends T ? OptionalProp<Exclude<T, undefined>> | DeferredProp<Exclude<T, undefined>> : NotOptional);

/** In place of `optional()`/`defer()` for a shared prop that is always there — the property name is the message. */
interface NotOptional {
  readonly [PROP]: 'optional' | 'defer';
  readonly 'optional() and defer() make a shared prop possibly missing: declare it as `T | undefined` in SharedProps': true;
}
