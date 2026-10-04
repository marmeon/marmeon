import { OLD_INPUT_KEY, type FlashEntry, type ValidationErrors } from '@bespokecore/http';
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
/** Flash messages (E60) waiting for a response that is shown. */
const MESSAGES = '_flash_messages';
/** At most this many wait: an app that never shows them does not grow the session without end (the oldest go). */
const MAX_MESSAGES = 20;
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
  /** The session came from the store (it is not new in this request). */
  #loaded = false;
  readonly #obsolete: string[] = [];
  /** Set for a read-only request (an island, E52): asked before every write. */
  #permit: ((what: string) => boolean) | undefined;
  /** The flash messages this request took (E60) — put back by `reflash()` (a 409: the page is requested again). */
  #taken: FlashEntry[] = [];
  /** Something bound to this session was handed out (its CSRF token, a live subscription — `persist()`): a new session is kept. */
  #issued = false;
  /** The ids the last `save()` destroyed — a sign-in or sign-out ended them (W6.10: their live streams close). */
  #ended: string[] = [];

  constructor(store: SessionStore, config: SessionConfig) {
    this.#store = store;
    this.#config = config;
  }

  get started(): boolean {
    return this.#started;
  }

  /**
   * Whether this request may not change the session — an island's (E52, `StartSession` locks it). Writes then throw in
   * development and are dropped in production; the session is never saved. Framework code that would write as a side
   * effect (a remember-me sign-in, the page a guest wanted) skips that instead.
   */
  get readOnly(): boolean {
    return this.#permit !== undefined;
  }

  /** @internal — `StartSession` locks the session of a read-only request: every write asks `permit` first. */
  lock(permit: (what: string) => boolean): void {
    this.#permit = permit;
  }

  /** Whether `what` may be written (always, unless the session is locked). */
  #may(what: string): boolean {
    return this.#permit === undefined || this.#permit(what);
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
    this.#loaded = data !== undefined;
    this.#started = true;
    if (typeof this.#data[TOKEN] !== 'string') this.regenerateToken();
  }

  /**
   * @internal — `StartSession` of an island the server resolves in-process while the page renders (E49): a copy of the
   * page request's session as it is now — whoever it signed in, its flash data — never shared with it. The island's
   * session is read-only and never saved.
   */
  adopt(page: Session): void {
    this.#id = page.id;
    this.#data = structuredClone(page.#data);
    // The page's session exists if it came from the store — or the page keeps it (a guest's page that signed a live channel).
    this.#loaded = page.exists;
    this.#started = true;
  }

  // -- Data ------------------------------------------------------------------

  get<K extends string>(key: K): Value<K> | undefined {
    return this.#ensureStarted()[key] as Value<K> | undefined;
  }

  has(key: string): boolean {
    return this.#ensureStarted()[key] !== undefined;
  }

  put<K extends string>(key: K, value: Value<K>): void {
    const data = this.#ensureStarted();
    if (this.#may(`session.put('${key}')`)) data[key] = value;
  }

  /** Returns the value and removes it. */
  pull<K extends string>(key: K): Value<K> | undefined {
    const value = this.get(key);
    this.forget(key);
    return value;
  }

  forget(...keys: string[]): void {
    const data = this.#ensureStarted();
    const present = keys.filter((key) => Object.hasOwn(data, key));
    // Forgetting what is not there changes nothing — not even for a read-only request.
    if (present.length === 0 || !this.#may(`session.forget('${present.join("', '")}')`)) return;
    for (const key of present) delete data[key];
  }

  /** Everything except the framework's bookkeeping (`_token`, `_flash`, …). */
  all(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.#ensureStarted()).filter(([key]) => !key.startsWith('_')));
  }

  /** Removes all data, the CSRF token included. */
  flush(): void {
    this.#ensureStarted();
    if (this.#may('session.flush()')) this.#data = {};
  }

  // -- Flash data ------------------------------------------------------------

  /** Stores a value for this and the next request only. */
  flash<K extends string>(key: K, value: Value<K>): void {
    const data = this.#ensureStarted();
    if (!this.#may(`session.flash('${key}')`)) return;
    data[key] = value;
    const flash = this.#flash();
    flash.new = [...new Set([...flash.new, key])];
    flash.old = flash.old.filter((old) => old !== key);
  }

  /**
   * Keeps all flash data for one more request — and puts back the flash messages this request took (E60): its answer is
   * not shown after all (a 409 that loads the page again).
   */
  reflash(): void {
    this.#ensureStarted();
    if (!this.#may('session.reflash()')) return;
    const flash = this.#flash();
    flash.new = [...new Set([...flash.new, ...flash.old])];
    flash.old = [];
    if (this.#taken.length > 0) {
      const waiting = (this.#ensureStarted()[MESSAGES] as FlashEntry[] | undefined) ?? [];
      this.#ensureStarted()[MESSAGES] = [...this.#taken, ...waiting].slice(-MAX_MESSAGES);
      this.#taken = [];
    }
  }

  /**
   * Keeps a flash message (E60, `redirect().flash()`) until a response the user is shown takes it — not aged by the
   * requests in between (a prefetch, an island, an API call).
   */
  queueFlash(message: FlashEntry): void {
    const data = this.#ensureStarted();
    if (!this.#may(`session.queueFlash('${message.key}')`)) return;
    data[MESSAGES] = [...((data[MESSAGES] as FlashEntry[] | undefined) ?? []), message].slice(-MAX_MESSAGES);
  }

  /**
   * The flash messages waiting, taken — by the response that delivers them. Nothing for a read-only request (an island,
   * a layer's base resolved in-process: they are not what the user is shown) or an unstarted session.
   */
  hasFlash(): boolean {
    return this.#started && ((this.#data[MESSAGES] as FlashEntry[] | undefined) ?? []).length > 0;
  }

  takeFlash(): FlashEntry[] {
    if (!this.#started || this.#permit) return [];
    const waiting = (this.#data[MESSAGES] as FlashEntry[] | undefined) ?? [];
    if (waiting.length === 0) return [];
    delete this.#data[MESSAGES];
    this.#taken.push(...waiting);
    return waiting;
  }

  /** Keeps some flash data for one more request. */
  keep(...keys: string[]): void {
    this.#ensureStarted();
    if (!this.#may(`session.keep('${keys.join("', '")}')`)) return;
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

  /**
   * The CSRF token of this session — handed out: a new session whose token an app puts into a response itself is saved,
   * so the token is still valid when the browser sends it back. Pages do not need to: `PageObject.csrf` (what `<Form>`
   * renders, `usePage().csrf`) carries the token of a session that is kept anyway, and a guest's forms pass without one by
   * the browser's word (Fetch Metadata, Origin — E143). So a guest's page creates no session.
   */
  token(): string {
    const token = this.#ensureStarted()[TOKEN] as string;
    this.#issued = true;
    return token;
  }

  /**
   * Keeps this session even with nothing in it — something the browser got is bound to it: its CSRF token (`token()`), a live
   * subscription a page signed (W6.10). A guest's page that lets them upload files persists it too (an upload belongs to a
   * session, W6.9). Nothing changes for a session that is kept anyway; a read-only request (an island) keeps none.
   */
  persist(): void {
    this.#ensureStarted();
    this.#issued = true;
  }

  /** @internal — the token without handing it out: what `VerifyCsrfToken` compares a request's token against. */
  currentToken(): string {
    return this.#ensureStarted()[TOKEN] as string;
  }

  /**
   * Whether `save()` writes this session (and `StartSession` sends its cookie). Always for a session that came from the
   * store. A NEW session only once something is written: data, flash messages or errors (a failed form), a sign-in — or
   * something bound to it went out: its CSRF token handed out explicitly (`token()`), a live subscription (`persist()`). A
   * request that leaves nothing — a guest's page (E143), a health check, an API call, a bot's redirect, a JSON endpoint that
   * never touches the session — leaves no session behind either (no row, no file, no cookie).
   */
  get persists(): boolean {
    const data = this.#ensureStarted();
    if (this.#permit) return false;
    return this.#loaded || this.#issued || Object.keys(data).some((key) => key !== TOKEN && key !== FLASH);
  }

  /**
   * Whether the session outlives this request: it came from the store, or this request keeps it (`persists`). For a read-only
   * request (an island, a live stream, an upload) — which never keeps a new one — whether the session it reads exists.
   */
  get exists(): boolean {
    if (!this.#started) return false;
    return this.#loaded || (this.#permit === undefined && this.persists);
  }

  regenerateToken(): void {
    const data = this.#ensureStarted();
    if (!this.#may('session.regenerateToken()')) return;
    data[TOKEN] = crypto.getRandomValues(new Uint8Array(30)).toBase64({ alphabet: 'base64url' });
  }

  /**
   * A new id (and CSRF token) for the same data — after login, so an id planted
   * before cannot ride along (session fixation). The old id is destroyed on save.
   */
  regenerate(): void {
    this.#ensureStarted();
    if (!this.#may('session.regenerate()')) return;
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

  /**
   * Ages flash data and writes the session. `StartSession` calls this after the route. Returns whether it wrote — false
   * for a read-only request, for a new session with nothing worth keeping (`persists`), and for a session another
   * request destroyed meanwhile.
   *
   * That other request was a sign-out (`invalidate()`) or a sign-in (`regenerate()`) of the same browser, which
   * overtook this one — say, while a page's deferred props were still loading. Writing the old session back would
   * undo the sign-out (its data still has the user). So a loaded session is written back with the store's atomic
   * `writeIfExists` (E45): a destroyed one stays destroyed, and the browser keeps the cookie it got from the faster
   * request. (The cookie driver cannot know: its data travels with each response.)
   */
  async save(): Promise<boolean> {
    this.#ensureStarted();
    // A read-only request never writes the session back: its flash data stays for the page it was meant for.
    if (this.#permit) return false;
    const flash = this.#flash();
    for (const key of flash.old) delete this.#data[key];
    flash.old = flash.new;
    flash.new = [];
    if (flash.old.length === 0) delete this.#data[FLASH]; // nothing to age: no bookkeeping stored

    const lifetime = this.#config.lifetime * 60;
    // The session this request loaded, under its id: written back only while it still exists — one atomic step.
    if (this.#loaded && this.#obsolete.length === 0) return this.#store.writeIfExists(this.#id, this.#data, lifetime);
    // New, or regenerated (a new id): the old id goes, the new one is written — unless a new session holds nothing.
    this.#ended = this.#obsolete.splice(0);
    for (const id of this.#ended) await this.#store.destroy(id);
    if (!this.persists) return false;
    await this.#store.write(this.#id, this.#data, lifetime);
    return true;
  }

  /** The ids the last `save()` destroyed: the session was regenerated (signed in) or invalidated (signed out). */
  get ended(): readonly string[] {
    return this.#ended;
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
