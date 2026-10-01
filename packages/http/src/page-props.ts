import { PAGE_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PARTIAL_EXCEPT_HEADER, type PageObject } from './page.ts';
import { propKind, resolveProp } from './props.ts';
import type { SharedData } from './shared-data.ts';

/** What a partial reload asks for: the props named in `only` (if given), minus those in `except`. */
export interface PartialReload {
  readonly only: readonly string[] | undefined;
  readonly except: readonly string[];
}

/**
 * The partial reload a request asks for — only for a client-side visit (`x-bespoke`) whose partial component is
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
export type ResolvedPage = Pick<PageObject, 'props' | 'deferredProps' | 'mergeProps' | 'deepMergeProps'>;

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
): Promise<ResolvedPage> {
  const all = new Map<string, unknown>(shared?.entries() ?? []);
  for (const [key, value] of Object.entries(props)) all.set(key, value);

  const send: string[] = [];
  const deferredProps: Record<string, string[]> = {};
  const mergeProps: string[] = [];
  const deepMergeProps: string[] = [];
  for (const [key, value] of all) {
    const kind = propKind(value);
    if (!included(key, kind, partial)) {
      // Deferred props are announced on full responses — a partial reload is the browser loading them.
      if (kind === 'defer' && partial === undefined) (deferredProps[(value as { group: string }).group] ??= []).push(key);
      continue;
    }
    send.push(key);
    if (kind === 'merge') mergeProps.push(key);
    if (kind === 'deepMerge') deepMergeProps.push(key);
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
