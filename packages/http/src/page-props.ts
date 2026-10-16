import { ONCE_HEADER, ONCE_SCOPE_HEADER, PAGE_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PARTIAL_EXCEPT_HEADER, type OnceInfo, type PageObject } from './protocol.ts';
import { mergeOf, propKind, resolveProp, type OnceProp } from './props.ts';
import type { SharedData } from './shared-data.ts';

/** What a partial reload asks for: the props named in `only` (if given), minus those in `except`. */
export interface PartialReload {
  readonly only: readonly string[] | undefined;
  readonly except: readonly string[];
}

/**
 * The partial reload a request asks for — only for a client-side visit (`x-marmeon`) whose partial component is
 * the one being rendered. Anything else (a full page load, a visit that ends on another page) gets every prop.
 */
export function partialReloadOf(request: Request, component: string): PartialReload | undefined {
  const { headers } = request;
  if (headers.get(PAGE_HEADER) !== 'true' || headers.get(PARTIAL_COMPONENT_HEADER) !== component) return undefined;
  const only = headers.has(PARTIAL_DATA_HEADER) ? list(headers.get(PARTIAL_DATA_HEADER)) : undefined;
  const except = list(headers.get(PARTIAL_EXCEPT_HEADER));
  return only === undefined && except.length === 0 ? undefined : { only, except };
}

function list(header: string | null): string[] {
  return (header ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

/** The part of the page object the props make up. */
export type ResolvedPage = Pick<PageObject, 'props' | 'deferredProps' | 'mergeProps' | 'deepMergeProps' | 'matchPropsOn' | 'onceProps'>;

/** How a page's once props are resolved: for which view, and which of them the browser holds. */
export interface OnceContext {
  /** The view — the default key of a page's own once prop is `<view>:<prop>`. */
  readonly component: string;
  /** The keys the browser holds under the current scope (see {@link heldOnceProps}) — not computed again. */
  readonly held: ReadonlySet<string>;
  /** Now, by the server's clock (for `ttl`). Default `Date.now()`. */
  readonly now?: number;
}

/**
 * The once props the browser of `request` holds — only when it names the scope they were sent under and that is the
 * request's scope now (`current`: the session's, see `PageSession.scope`). A browser that kept them for someone else — another
 * tab signed in as another user, the cookie changed under this tab — holds nothing as far as the server is concerned.
 */
export function heldOnceProps(request: Request, current: string | undefined): ReadonlySet<string> {
  const { headers } = request;
  if (headers.get(PAGE_HEADER) !== 'true') return new Set();
  if ((headers.get(ONCE_SCOPE_HEADER) ?? undefined) !== current) return new Set();
  return new Set(list(headers.get(ONCE_HEADER)));
}

/** The key the browser keeps a once prop under: its own, the shared prop's name, or `<view>:<prop>`. */
function onceKey(prop: OnceProp<unknown>, name: string, shared: boolean, component: string): string {
  return prop.key ?? (shared ? name : `${component}:${name}`);
}

/**
 * Resolves what a response sends of a page's props — the controller's and the shared ones (the controller's win).
 * Only what is sent is computed (lazy shared props, functions, `optional`, `defer`):
 * - a full response: everything except `optional` and `defer` props; the deferred ones are listed by group.
 * - a partial reload: the props named in `only` (else all but `optional`/`defer`), minus `except`, plus `always`.
 *
 * It only ever *filters* what the controller returned: a prop the controller left out (say, for someone not
 * allowed to see it) cannot be asked for.
 */
export async function resolvePageProps(
  props: Readonly<Record<string, unknown>>,
  shared: SharedData | undefined,
  partial: PartialReload | undefined,
  once?: OnceContext,
): Promise<ResolvedPage> {
  const all = new Map<string, unknown>(shared?.entries() ?? []);
  for (const [key, value] of Object.entries(props)) all.set(key, value);

  const send: string[] = [];
  const deferredProps: Record<string, string[]> = {};
  const mergeProps: string[] = [];
  const deepMergeProps: string[] = [];
  const matchPropsOn: string[] = [];
  const onceProps: Record<string, OnceInfo> = {};
  for (const [key, value] of all) {
    const kind = propKind(value);
    if (!included(key, kind, partial)) {
      // Deferred props are announced on full responses — a partial reload is the browser loading them.
      if (kind === 'defer' && partial === undefined) (deferredProps[(value as { group: string }).group] ??= []).push(key);
      continue;
    }
    if (kind === 'once' && once) {
      // A once prop: announced with its key — and not computed while the browser holds it, unless asked for by name.
      const prop = value as OnceProp<unknown>;
      const info: OnceInfo = { key: onceKey(prop, key, !Object.hasOwn(props, key), once.component), ...(prop.ttl !== undefined ? { expiresAt: (once.now ?? Date.now()) + prop.ttl } : {}) };
      onceProps[key] = info;
      if (once.held.has(info.key) && !partial?.only?.includes(key)) continue;
    }
    send.push(key);
    // `merge()`/`deepMerge()` — and `defer(…).merge()`, once it is sent.
    const merging = mergeOf(value);
    if (merging) {
      (merging.strategy === 'merge' ? mergeProps : deepMergeProps).push(key);
      for (const match of merging.match) matchPropsOn.push(`${key}.${match}`);
    }
  }

  const fromShared = send.filter((key) => !Object.hasOwn(props, key));
  const [sharedValues, own] = await Promise.all([
    shared && fromShared.length > 0 ? shared.resolve(fromShared) : {},
    Promise.all(send.filter((key) => Object.hasOwn(props, key)).map(async (key) => [key, await resolveProp(props[key])] as const)),
  ]);
  // In the order the props were given — shared first.
  const values: Record<string, unknown> = { ...sharedValues, ...Object.fromEntries(own) };
  const resolved: Record<string, unknown> = {};
  for (const key of send) resolved[key] = values[key];

  return {
    props: resolved,
    ...(Object.keys(deferredProps).length > 0 ? { deferredProps } : {}),
    ...(mergeProps.length > 0 ? { mergeProps } : {}),
    ...(deepMergeProps.length > 0 ? { deepMergeProps } : {}),
    ...(matchPropsOn.length > 0 ? { matchPropsOn } : {}),
    ...(Object.keys(onceProps).length > 0 ? { onceProps } : {}),
  };
}

/** Where a page's props came from — what the devtools show beside each. */
export interface PropOrigins {
  /** Sent props that are shared (`SharedData`), not the controller's own. */
  readonly shared: readonly string[];
  /** `optional()` props the response left out — sent only when a partial reload names them. */
  readonly optional: readonly string[];
}

/** Which of the props `sent` are shared, and which `optional()` props were left out — from the props given, never resolved. */
export function propOrigins(props: Readonly<Record<string, unknown>>, shared: SharedData | undefined, sent: readonly string[]): PropOrigins {
  const all = new Map<string, unknown>(shared?.entries() ?? []);
  for (const [key, value] of Object.entries(props)) all.set(key, value);
  return {
    shared: sent.filter((key) => !Object.hasOwn(props, key) && all.has(key)),
    optional: [...all].filter(([key, value]) => propKind(value) === 'optional' && !sent.includes(key)).map(([key]) => key),
  };
}

function included(key: string, kind: ReturnType<typeof propKind>, partial: PartialReload | undefined): boolean {
  if (kind === 'always') return true;
  const lazy = kind === 'optional' || kind === 'defer';
  if (!partial) return !lazy;
  if (partial.except.includes(key)) return false;
  // `optional` and `defer` props only by name: an `except` alone never computes them.
  return partial.only ? partial.only.includes(key) : !lazy;
}
