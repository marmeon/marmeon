/**
 * Merging partial reloads into what a page (or a region) has — `merge()`, `deepMerge()`, `matchOn()` and deferred props —
 * and the other ways a loaded page is shaped before it lands: only some props (`pick`), deferred ones kept, the query kept.
 */
import type { PageObject } from '../page.ts';

/**
 * The page after a partial reload: the props it had, with the new ones — merged where the server marked them
 * (`mergeProps`: arrays appended, objects merged one level; `deepMergeProps`: all the way down), unless `reset`.
 * Deferred props that arrived are no longer pending.
 */
export function mergePage(current: PageObject, partial: PageObject, reset: readonly string[] = []): PageObject {
  const props: Record<string, unknown> = { ...current.props };
  const match = partial.matchPropsOn ?? [];
  for (const [key, value] of Object.entries(partial.props)) {
    if (reset.includes(key)) props[key] = value;
    else if (partial.mergeProps?.includes(key)) props[key] = mergeValues(props[key], value, false, key, match);
    else if (partial.deepMergeProps?.includes(key)) props[key] = mergeValues(props[key], value, true, key, match);
    else props[key] = value;
  }
  const { deferredProps: _pending, mergeProps: _merge, deepMergeProps: _deep, matchPropsOn: _match, ...rest } = partial;
  const deferredProps = stillPending(current.deferredProps, Object.keys(partial.props));
  const mergeProps = union(current.mergeProps, partial.mergeProps);
  const deepMergeProps = union(current.deepMergeProps, partial.deepMergeProps);
  const matchPropsOn = union(current.matchPropsOn, partial.matchPropsOn);
  return {
    ...rest,
    props,
    ...(deferredProps ? { deferredProps } : {}),
    ...(mergeProps ? { mergeProps } : {}),
    ...(deepMergeProps ? { deepMergeProps } : {}),
    ...(matchPropsOn ? { matchPropsOn } : {}),
  };
}

/** Merges `next` into `current`, at `path` of the props (`others.data`) — arrays by the key `matchPropsOn` names for the path. */
function mergeValues(current: unknown, next: unknown, deep: boolean, path: string, match: readonly string[]): unknown {
  if (Array.isArray(current) && Array.isArray(next)) return append(current, next, matchKey(path, match));
  if (isPlainObject(current) && isPlainObject(next)) {
    if (!deep) return { ...current, ...next };
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(next)) merged[key] = Object.hasOwn(current, key) ? mergeValues(current[key], value, true, `${path}.${key}`, match) : value;
    return merged;
  }
  return next;
}

/** The key that identifies the items of the array at `path` — `matchPropsOn: ['others.data.id']` → `id` for `others.data`. */
function matchKey(path: string, match: readonly string[]): string | undefined {
  const prefix = `${path}.`;
  return match.find((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('.'))?.slice(prefix.length);
}

/**
 * `next` after `current` — with a `key`, an item whose key is shown already takes that one's place (the same page
 * loaded twice: a poll, "load more" clicked twice) instead of appearing again.
 */
function append(current: readonly unknown[], next: readonly unknown[], key: string | undefined): unknown[] {
  if (key === undefined) return [...current, ...next];
  const merged = [...current];
  const at = new Map<unknown, number>();
  merged.forEach((item, index) => {
    if (isPlainObject(item) && item[key] !== undefined) at.set(item[key], index);
  });
  for (const item of next) {
    const id = isPlainObject(item) ? item[key] : undefined;
    const index = id === undefined ? undefined : at.get(id);
    if (index !== undefined) {
      merged[index] = item;
    } else {
      if (id !== undefined) at.set(id, merged.length);
      merged.push(item);
    }
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

function union(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | undefined {
  if (!a && !b) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
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
