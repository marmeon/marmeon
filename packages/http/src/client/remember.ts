/**
 * Remembered state, UI-free: what a form or a component wants back when Back/Forward returns to its history entry. Kept in
 * memory only, per history entry, and gone with the entry and with the document — never in `history.state` or `sessionStorage`,
 * which browsers restore from disk, past a sign-out. Fields named like a token, a secret, a credential, a one-time or recovery code or a card
 * (the terms are in `sensitive-fields.ts`) are not kept unless a form names them in `include`; passwords and files never, at any depth. See docs/navigation.md#remembered-state.
 */

import { slot } from './feature.ts';

// The name rules are a module of their own, loaded when something is first remembered: a download that remembers nothing never
// carries them. Until they are loaded nothing is kept (never a guess), so a write that comes first waits for them.
let rules: typeof import('../sensitive-fields.ts') | undefined;
let loading: Promise<void> | undefined;

/** Loads the rules that tell sensitive fields; resolves once {@link isSensitiveRememberField} and {@link rememberable} can answer. */
export function loadSensitiveFields(): Promise<void> {
  return (loading ??= import('../sensitive-fields.ts').then(
    (module) => void (rules = module),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  ));
}

/**
 * Whether a field (a name or a path: `payment.card_number`) is left out of remembered state — `include` lets in all but
 * passwords. `true` for everything until {@link loadSensitiveFields} has resolved.
 */
export function isSensitiveRememberField(field: string, include: readonly string[] = []): boolean {
  if (!rules) return true;
  if (rules.isPasswordField(field)) return true;
  return !include.includes(field) && rules.isSensitiveField(field);
}

/**
 * What may be remembered of `value`: a copy without sensitive fields (by name, at any depth — `include` lets some back in,
 * never a password) and without files, functions or anything else that is not plain data. `undefined` for nothing at all
 * — and until {@link loadSensitiveFields} has resolved.
 */
export function rememberable(value: unknown, include: readonly string[] = []): unknown {
  if (!rules) return undefined;
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
 * The remembered state of one history entry — a level of the screen: the page, or a layer. Keys are the app's
 * (`useRemember('tab', …)`, `useForm(…, { remember: 'profile-edit' })`); an island's are prefixed with it by the adapter.
 */
export class Remembered {
  readonly #values = new Map<string, unknown>();
  // A write that waits for the rules holds a ticket: `set` and `delete` of its key, and `clear()`, take it back — what was
  // forgotten, or replaced, does not come back when the rules arrive.
  readonly #tickets = new Map<string, number>();
  #epoch = 0;

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

  /**
   * Remembers what may be kept of a value under `key` ({@link rememberable}) — the value, or a function that gives it. The
   * first write of a document waits for the rules that tell sensitive fields (a chunk of their own); the function is called
   * then, not now, and a later `set` or `delete` of the key, or `clear()`, cancels the wait. `field` names the key as a field
   * of its own (`useRemember('password-tab')`): when it is sensitive, nothing is kept.
   */
  set(key: string, source: unknown, include: readonly string[] = [], field?: string): void {
    const ticket = (this.#tickets.get(key) ?? 0) + 1;
    this.#tickets.set(key, ticket);
    if (!rules) {
      const epoch = this.#epoch;
      loadSensitiveFields().then(
        () => this.#epoch === epoch && this.#tickets.get(key) === ticket && this.set(key, source, include, field),
        () => {},
      );
      return;
    }
    const kept = field !== undefined && isSensitiveRememberField(field, include) ? undefined : rememberable(typeof source === 'function' ? source() : source, include);
    if (kept === undefined) this.#values.delete(key);
    else this.#values.set(key, kept);
  }

  delete(key: string): void {
    this.#tickets.set(key, (this.#tickets.get(key) ?? 0) + 1);
    this.#values.delete(key);
  }

  /** Forgets everything (the document is left). */
  clear(): void {
    this.#epoch++;
    this.#tickets.clear();
    this.#values.clear();
  }

  /** The keys remembered (tests, devtools). */
  keys(): string[] {
    return [...this.#values.keys()];
  }
}

/** What a history entry's components remembered — a slot of the entry: the core empties it with the entry. */
export const REMEMBERED = slot('remembered', () => new Remembered());
