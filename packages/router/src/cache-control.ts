import { editableResponse } from './response.ts';

/** Directives that let a shared cache store an answer or keep it fresh for others. */
const SHARED = new Set(['public', 's-maxage', 'proxy-revalidate']);
/** Headers a CDN or proxy obeys in place of `Cache-Control`. */
const CDN_HEADERS = ['cdn-cache-control', 'surrogate-control'];
/** The most keys {@link SharedCacheWarnings} remembers: a key is a route, but a table that grows needs an end. */
const MAX_WARNED = 500;

export type SharedCacheOutcome = 'kept' | 'changed' | 'downgraded';

/**
 * Makes `response` something no shared cache may store: `public`, `s-maxage` and `proxy-revalidate` are dropped, `private`
 * leads, and `CDN-Cache-Control` and `Surrogate-Control` are removed. An answer that is `no-store` or `private` already stays
 * as it is. `downgraded` means the response asked for sharing (a warning is due), `changed` that `private` was only added.
 * Returns the response to hand on — a copy when the original may not be changed in place.
 * @internal
 */
export function keepFromSharedCaches(response: Response): { response: Response; outcome: SharedCacheOutcome } {
  const directives = splitDirectives(response.headers.get('cache-control') ?? '')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((text) => ({ text, name: (text.split('=')[0] ?? '').trim().toLowerCase(), qualified: text.includes('=') }));
  const noStore = directives.some((d) => d.name === 'no-store');
  // `private="x"` shields only the named fields: the rest of the answer would still be shared.
  const bare = directives.some((d) => d.name === 'private' && !d.qualified);
  const qualified = directives.some((d) => d.name === 'private' && d.qualified);
  const shared = directives.some((d) => SHARED.has(d.name));
  const cdn = CDN_HEADERS.filter((name) => response.headers.has(name));
  if ((noStore || bare) && !qualified && !shared && cdn.length === 0) return { response, outcome: 'kept' };

  const editable = editableResponse(response);
  const rest = directives.filter((d) => !SHARED.has(d.name) && d.name !== 'private').map((d) => d.text);
  editable.headers.set('cache-control', (noStore ? rest : ['private', ...rest]).join(', '));
  for (const name of cdn) editable.headers.delete(name);
  return { response: editable, outcome: shared || cdn.length > 0 ? 'downgraded' : 'changed' };
}

/** Splits at the commas outside quotes: `private="a, b", max-age=60` is two directives. */
function splitDirectives(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (character === ',' && !quoted) {
      parts.push(current);
      current = '';
    } else current += character;
  }
  parts.push(current);
  return parts;
}

/** Which routes were warned about already, so a log carries one line per route. Bounded: a key is a route, never a raw path. */
export class SharedCacheWarnings {
  readonly #seen = new Set<string>();

  /** Whether this is the first time `key` (a route name, or `METHOD pattern`) asks — and it can still be remembered. */
  first(key: string): boolean {
    if (this.#seen.has(key) || this.#seen.size >= MAX_WARNED) return false;
    this.#seen.add(key);
    return true;
  }
}
