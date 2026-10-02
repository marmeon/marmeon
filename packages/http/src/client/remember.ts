/**
 * Remembered state (E63), UI-free: what a form or a component wants back when Back/Forward returns to its history entry —
 * typed input, an open tab, a filter not sent yet. Kept **in memory only**, per history entry (the page's, a layer's), next to
 * the entry's page and islands in the navigator's cache (E36): never in `history.state` (browsers write it to disk for session
 * restore, and it outlives a sign-out), never in `sessionStorage` (restored from disk too).
 *
 * Gone with the entry — evicted from the cache, a layer closed for good — and with the document: a reload, signing in or out,
 * a new build, a language switch (every 409). There is no tab sync (E66): another tab keeps its remembered state after a
 * sign-out here, until it navigates or reloads.
 *
 * Sensitive values are never kept: fields named like a password, a token, a secret or a card (`/password|secret|token|card|cvc/i`),
 * at any depth, and files. Passwords never, even when asked; the others when a form names them (`include`).
 */

import { slot } from './feature.ts';

/** Field names whose values are never remembered — unless a form names them in `include` (passwords: never). */
export const SENSITIVE_REMEMBER_FIELD = /password|secret|token|card|cvc/i;

/** Field names whose values are never remembered, whatever a form asks for. */
export const NEVER_REMEMBERED_FIELD = /password/i;

/** Whether a field (a name or a path: `payment.card_number`) is left out of remembered state. */
export function isSensitiveRememberField(field: string, include: readonly string[] = []): boolean {
  if (field.split(/[.[\]]+/).some((segment) => NEVER_REMEMBERED_FIELD.test(segment))) return true;
  if (include.includes(field)) return false;
  return field.split(/[.[\]]+/).some((segment) => segment !== '' && SENSITIVE_REMEMBER_FIELD.test(segment));
}

/**
 * What may be remembered of `value`: a copy without sensitive fields (by name, at any depth — `include` lets some back in,
 * never a password) and without files, functions or anything else that is not plain data. `undefined` for nothing at all.
 */
export function rememberable(value: unknown, include: readonly string[] = []): unknown {
  const copy = (item: unknown, path: string): unknown => {
    if (item instanceof Blob || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') return undefined;
    if (item instanceof Date) return new Date(item.getTime());
    if (Array.isArray(item)) return item.map((entry, index) => copy(entry, path === '' ? String(index) : `${path}.${index}`)).filter((entry) => entry !== undefined);
    if (typeof item === 'object' && item !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item)) {
        const field = path === '' ? key : `${path}.${key}`;
        if (isSensitiveRememberField(field, include)) continue;
        const kept = copy(entry, field);
        if (kept !== undefined) result[key] = kept;
      }
      return result;
    }
    return item;
  };
  return copy(value, '');
}

/**
 * The remembered state of one history entry — a level of the screen: the page, or a layer (E53). Keys are the app's
 * (`useRemember('tab', …)`, `useForm(…, { remember: 'profile-edit' })`); an island's are prefixed with it by the adapter.
 */
export class Remembered {
  readonly #values = new Map<string, unknown>();

  get size(): number {
    return this.#values.size;
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  /** What was remembered under `key` — a copy (changing it changes nothing kept). */
  get(key: string): unknown {
    return this.#values.has(key) ? structuredClone(this.#values.get(key)) : undefined;
  }

  /** Remembers `value` under `key` — a copy of what may be kept of it ({@link rememberable}). */
  set(key: string, value: unknown, include: readonly string[] = []): void {
    const kept = rememberable(value, include);
    if (kept === undefined) this.#values.delete(key);
    else this.#values.set(key, kept);
  }

  delete(key: string): void {
    this.#values.delete(key);
  }

  /** Forgets everything (the document is left). */
  clear(): void {
    this.#values.clear();
  }

  /** The keys remembered (tests, devtools). */
  keys(): string[] {
    return [...this.#values.keys()];
  }
}

/** What a history entry's components remembered (E63) — a slot of the entry: the core empties it with the entry. */
export const REMEMBERED = slot('remembered', () => new Remembered());
