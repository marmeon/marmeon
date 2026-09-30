import { OLD_INPUT_KEY, type ValidationErrors } from '@bespokecore/http';
import { SessionConfig } from './config.ts';
import { createSessionId, SESSION_ID, SessionStore, type SessionPayload } from './store.ts';

/**
 * Typed session keys. Apps and packages declare what they store:
 *
 * ```ts
 * declare module '@bespokecore/session' {
 *   interface SessionData { user_id: string }
 * }
 * ```
 *
 * Declared keys are checked (`put('user_id', 1)` is an error); other keys are `unknown`.
 */
export interface SessionData {
  /** Validation errors of the previous request (flashed by a failed page request). */
  errors: ValidationErrors;
}

type Value<K extends string> = K extends keyof SessionData ? SessionData[K] : unknown;

const FLASH = '_flash';
const TOKEN = '_token';
const OLD_INPUT = OLD_INPUT_KEY; // what `redirect().withInput()` flashes

interface FlashState {
  new: string[];
  old: string[];
}

/**
 * The session of the current request (Laravel's `Session\Store`). Scoped: one per
 * request, injected into controllers, middleware and listeners alike.
 * `StartSession` loads it before the route and saves it afterwards.
 *
 * Values must survive `JSON.stringify` — a `Date` comes back as a string.
 */
export class Session {
  readonly #store: SessionStore;
  readonly #config: SessionConfig;
  #id = '';
  #data: SessionPayload = {};
  #started = false;
  readonly #obsolete: string[] = [];

  constructor(store: SessionStore, config: SessionConfig) {
    this.#store = store;
    this.#config = config;
  }

  get started(): boolean {
    return this.#started;
  }

  get id(): string {
    this.#ensureStarted();
    return this.#id;
  }

  /** Loads the session `id` (from the cookie), or starts a new one if it is unknown or expired. */
  async start(id?: string): Promise<void> {
    const data = id && SESSION_ID.test(id) ? await this.#store.read(id) : undefined;
    this.#id = data ? id! : createSessionId();
    this.#data = data ?? {};
    this.#started = true;
    if (typeof this.#data[TOKEN] !== 'string') this.regenerateToken();
  }

  // -- Data ------------------------------------------------------------------

  get<K extends string>(key: K): Value<K> | undefined {
    return this.#ensureStarted()[key] as Value<K> | undefined;
  }

  has(key: string): boolean {
    return this.#ensureStarted()[key] !== undefined;
  }

  put<K extends string>(key: K, value: Value<K>): void {
    this.#ensureStarted()[key] = value;
  }

  /** Returns the value and removes it. */
  pull<K extends string>(key: K): Value<K> | undefined {
    const value = this.get(key);
    this.forget(key);
    return value;
  }

  forget(...keys: string[]): void {
    const data = this.#ensureStarted();
    for (const key of keys) delete data[key];
  }

  /** Everything except the framework's bookkeeping (`_token`, `_flash`, …). */
  all(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.#ensureStarted()).filter(([key]) => !key.startsWith('_')));
  }

  /** Removes all data, the CSRF token included. */
  flush(): void {
    this.#ensureStarted();
    this.#data = {};
  }

  // -- Flash data ------------------------------------------------------------

  /** Stores a value for this and the next request only. */
  flash<K extends string>(key: K, value: Value<K>): void {
    this.put(key, value);
    const flash = this.#flash();
    flash.new = [...new Set([...flash.new, key])];
    flash.old = flash.old.filter((old) => old !== key);
  }

  /** Keeps all flash data for one more request. */
  reflash(): void {
    const flash = this.#flash();
    flash.new = [...new Set([...flash.new, ...flash.old])];
    flash.old = [];
  }

  /** Keeps some flash data for one more request. */
  keep(...keys: string[]): void {
    const flash = this.#flash();
    flash.new = [...new Set([...flash.new, ...keys])];
    flash.old = flash.old.filter((key) => !keys.includes(key));
  }

  /** Flashes the request input, so the next page can refill the form (`old()`). */
  flashInput(input: Record<string, unknown>): void {
    this.flash(OLD_INPUT, input);
  }

  /** Input flashed by the previous request — all of it, or one field. */
  old(): Record<string, unknown>;
  old(key: string): unknown;
  old(key?: string): unknown {
    const input = (this.get(OLD_INPUT) ?? {}) as Record<string, unknown>;
    return key === undefined ? input : input[key];
  }

  // -- Security --------------------------------------------------------------

  /** The CSRF token of this session. */
  token(): string {
    return this.#ensureStarted()[TOKEN] as string;
  }

  regenerateToken(): void {
    this.#ensureStarted()[TOKEN] = crypto.getRandomValues(new Uint8Array(30)).toBase64({ alphabet: 'base64url' });
  }

  /**
   * A new id (and CSRF token) for the same data — after login, so an id planted
   * before cannot ride along (session fixation). The old id is destroyed on save.
   */
  regenerate(): void {
    this.#ensureStarted();
    this.#obsolete.push(this.#id);
    this.#id = createSessionId();
    this.regenerateToken();
  }

  /** Ends the session: all data gone, new id, new token — for logout. */
  invalidate(): void {
    this.flush();
    this.regenerate();
  }

  // -- Persistence -----------------------------------------------------------

  /** Ages flash data and writes the session. `StartSession` calls this after the route. */
  async save(): Promise<void> {
    this.#ensureStarted();
    const flash = this.#flash();
    for (const key of flash.old) delete this.#data[key];
    flash.old = flash.new;
    flash.new = [];

    const lifetime = this.#config.lifetime * 60;
    for (const id of this.#obsolete.splice(0)) await this.#store.destroy(id);
    await this.#store.write(this.#id, this.#data, lifetime);
  }

  #flash(): FlashState {
    const data = this.#ensureStarted();
    const flash = (data[FLASH] ??= { new: [], old: [] }) as FlashState;
    return flash;
  }

  #ensureStarted(): SessionPayload {
    if (!this.#started) {
      throw new Error('The session has not been started — add the StartSession middleware to this route (or its group).');
    }
    return this.#data;
  }
}
