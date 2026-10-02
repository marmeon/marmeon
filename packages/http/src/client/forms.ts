import type { PageObject } from '../page.ts';

/**
 * The first validation message per field of a page — the server sends a list per field (the shared `errors` prop,
 * after it redirected back to the form); forms show the first. Empty when the page has none.
 */
export function firstErrors(page: PageObject): Record<string, string> {
  const errors = (page.props as { errors?: unknown }).errors;
  if (typeof errors !== 'object' || errors === null) return {};
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(errors)) {
    const first = Array.isArray(messages) ? messages[0] : messages;
    if (typeof first === 'string') result[field] = first;
  }
  return result;
}

/**
 * The fields of a form that differ from where it started (E64) — as paths: `name`, `address.city`, `links.0.url`. Leaves of
 * objects and arrays are compared one by one; an array that changed its length is dirty as a whole (and so are the items
 * that differ). Values compare as JSON would send them (a `Date` by its string); a `File` by identity.
 */
export function dirtyPaths(initial: unknown, current: unknown, prefix = ''): string[] {
  if (Object.is(initial, current)) return [];
  const plain = (value: unknown) => typeof value === 'object' && value !== null && !(value instanceof Blob) && !(value instanceof Date);
  if (!plain(initial) || !plain(current) || Array.isArray(initial) !== Array.isArray(current)) {
    return comparable(initial) === comparable(current) ? [] : [prefix];
  }
  const paths: string[] = [];
  if (Array.isArray(initial) && Array.isArray(current) && initial.length !== current.length) paths.push(prefix);
  const before = initial as Record<string, unknown>;
  const after = current as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    paths.push(...dirtyPaths(before[key], after[key], prefix === '' ? key : `${prefix}.${key}`));
  }
  return paths.filter((path) => path !== '' || prefix !== '');
}

/** Whether `path` (or anything under it) is among `dirty` — no path: anything at all. */
export function isDirtyPath(dirty: readonly string[], path?: string): boolean {
  if (path === undefined || path === '') return dirty.length > 0;
  return dirty.some((candidate) => candidate === path || candidate.startsWith(`${path}.`));
}

function comparable(value: unknown): unknown {
  if (value instanceof Blob) return value;
  return value === undefined ? undefined : JSON.stringify(value);
}
