/**
 * Merging partial reloads into what a page (or a region) has — `merge()`, `deepMerge()`, `matchOn()` and deferred props —
 * and the other ways a loaded page is shaped before it lands: only some props (`pick`), deferred ones kept, the query kept.
 */
import type { PageObject } from '../protocol.ts';
import type { ReloadSpec } from './optimistic.ts';

/**
 * Which merged props a partial reload replaces instead (`reset`): these names, or — `true` — every prop it brought. A revalidation
 * (an action's reload, a live hint's, Back's) is `true`: what the server says now takes the place of what was there, so a row
 * deleted meanwhile is gone. "Load more" (a visit with `data`/`query`) resets nothing: it appends.
 * @internal
 */
export type ResetProps = readonly string[] | true;

/** The props a revalidation replaces (`ReloadSpec.reset`) — every one it brings unless it names some. */
export function resetOf(spec: ReloadSpec): ResetProps {
  return spec.reset ?? true;
}

/** The keys with which a page says how its props merge. */
export const MERGE_MARKS = ['mergeProps', 'deepMergeProps', 'matchPropsOn'] as const;

/**
 * The page after a partial reload: the props it had, with the new ones — merged where the server marked them
 * (`mergeProps`: arrays appended, objects merged one level — a paginator's `data` appended —; `deepMergeProps`: all the way
 * down), unless `reset`. Deferred props that arrived are no longer pending. What the page says about merging (`mergeProps`,
 * `deepMergeProps`, `matchPropsOn`) is the partial's for the props it brought and stays as it was for the others — it never
 * piles up over reloads.
 * @internal
 */
export function mergePage(current: PageObject, partial: PageObject, reset: ResetProps = []): PageObject {
  const props: Record<string, unknown> = { ...current.props };
  const match = partial.matchPropsOn ?? [];
  const arrived = Object.keys(partial.props);
  for (const [key, value] of Object.entries(partial.props)) {
    if (reset === true || reset.includes(key)) props[key] = value;
    else if (partial.mergeProps?.includes(key)) props[key] = mergeValues(props[key], value, false, key, match);
    else if (partial.deepMergeProps?.includes(key)) props[key] = mergeValues(props[key], value, true, key, match);
    else props[key] = value;
  }
  const page: PageObject = { ...partial, props };
  const deferredProps = stillPending(current.deferredProps, arrived);
  if (deferredProps) page.deferredProps = deferredProps;
  else delete page.deferredProps;
  // The partial's merge marks for the props it brought, the page's for the rest (entries start with the prop's name).
  for (const name of MERGE_MARKS) {
    const marks = [...new Set([...(current[name] ?? []).filter((entry) => !arrived.includes(entry.split('.', 1)[0]!)), ...(partial[name] ?? [])])];
    if (marks.length > 0) page[name] = marks;
    else delete page[name];
  }
  return page;
}

/**
 * Merges `next` into `current`, at `path` of the props (`others.data`) — arrays by the key `matchPropsOn` names for the path.
 * `merge()` (not deep) merges objects one level, except a paginator's `data` list (`{ data: [...], meta }`): appended like a
 * list of its own, the rest (`meta`) the new one's.
 */
function mergeValues(current: unknown, next: unknown, deep: boolean, path: string, match: readonly string[]): unknown {
  if (Array.isArray(current) && Array.isArray(next)) return append(current, next, matchKey(path, match));
  if (isPlainObject(current) && isPlainObject(next)) {
    const merged: Record<string, unknown> = { ...current, ...next };
    if (!deep) {
      if (Array.isArray(current.data) && Array.isArray(next.data)) merged.data = append(current.data, next.data, matchKey(`${path}.data`, match));
    } else {
      for (const key of Object.keys(next)) if (Object.hasOwn(current, key)) merged[key] = mergeValues(current[key], next[key], true, `${path}.${key}`, match);
    }
    return merged;
  }
  return next;
}

/**
 * The key that identifies the items of the array at `path` — a path into each item: `matchPropsOn: ['others.data.id']` → `id`
 * for `others.data`, `['feed.user.id']` → `user.id` for `feed`.
 */
function matchKey(path: string, match: readonly string[]): string | undefined {
  return match.find((entry) => entry.startsWith(`${path}.`))?.slice(path.length + 1);
}

/**
 * `next` after `current` — with a `key` (a path into each item), an item whose key is shown already takes that one's place (the
 * same page loaded twice: a poll, "load more" clicked twice) instead of appearing again.
 */
function append(current: readonly unknown[], next: readonly unknown[], key: string | undefined): unknown[] {
  if (key === undefined) return [...current, ...next];
  const keyOf = (item: unknown) => key.split('.').reduce<unknown>((value, part) => (isPlainObject(value) ? value[part] : undefined), item);
  const merged = [...current];
  const at = new Map<unknown, number>();
  merged.forEach((item, index) => at.set(keyOf(item), index));
  for (const item of next) {
    const id = keyOf(item);
    const index = id === undefined ? undefined : at.get(id);
    if (index === undefined) {
      at.set(id, merged.length);
      merged.push(item);
    } else merged[index] = item;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stillPending(groups: PageObject['deferredProps'], arrived: readonly string[]): PageObject['deferredProps'] {
  if (!groups) return undefined;
  const pending = Object.entries(groups)
    .map(([group, props]) => [group, props.filter((prop) => !arrived.includes(prop))] as const)
    .filter(([, props]) => props.length > 0);
  return pending.length > 0 ? Object.fromEntries(pending) : undefined;
}

/** Only these props (those `props` has). */
export function pick(props: Readonly<Record<string, unknown>>, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.filter((name) => Object.hasOwn(props, name)).map((name) => [name, props[name]]));
}

/**
 * A full reload's page in place of `current`: its deferred props (sent without, to load next) keep their values until they
 * load again — the page shows them instead of their fallback in between.
 */
export function keepDeferred(current: PageObject, loaded: PageObject): PageObject {
  const deferred = Object.values(loaded.deferredProps ?? {}).flat();
  const kept = pick(current.props, deferred.filter((name) => !Object.hasOwn(loaded.props, name)));
  return Object.keys(kept).length === 0 ? loaded : { ...loaded, props: { ...kept, ...loaded.props } };
}

/** `page` with the query of `from` (or without one, when `from` has none) — `preserveUrl`: the URL stays the one on screen. */
export function withQueryOf(page: PageObject, from: PageObject): PageObject {
  const { query: _query, queryDefaults: _defaults, ...rest } = page;
  return {
    ...rest,
    ...(from.query ? { query: from.query } : {}),
    ...(from.queryDefaults ? { queryDefaults: from.queryDefaults } : {}),
  };
}
