import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { ValidationErrors } from '@marmeon/http';
import { flashableInput, OLD_INPUT_KEY, type FlashEntry } from '@marmeon/http/internal';
import { SessionCodec } from './codec.ts';
import { SessionConfig } from './config.ts';
import { EMPTY_PAYLOAD, openPayload, sealPayload } from './format.ts';
import { createSessionId, SESSION_ID, SESSION_USER_KEY, sessionKey, SessionStore, type SessionPayload, type SessionWriteResult } from './store.ts';

/**
 * Typed session keys, declared by apps and packages through declaration merging:
 * `declare module '@marmeon/session' { interface SessionData { user_id: string } }`. Declared keys are checked
 * (`put('user_id', 1)` is an error); other keys are `unknown`.
 */
export interface SessionData {
  /** Validation errors of the previous request (flashed by a failed page request). */
  errors: ValidationErrors;
}

type Value<K extends string> = K extends keyof SessionData ? SessionData[K] : unknown;

const FLASH = '_flash';
/** Flash messages waiting for a response that is shown. */
const MESSAGES = '_flash_messages';
/** At most this many wait: an app that never shows them does not grow the session without end (the oldest go). */
const MAX_MESSAGES = 20;
const TOKEN = '_token';
const OLD_INPUT = OLD_INPUT_KEY; // what `redirect().withInput()` flashes
/**
 * How long `save()` keeps writing back a session that other requests write at the same time: each conflict waits a
 * random moment (up to 2, 4, 8, … 64 ms — so writers that collided do not collide again in step), reads it again and merges.
 * Every round lets at least one writer through, so 20 requests of one session at once all land — on a slow store
 * under load too; the bound only stops a request from waiting on a session that is written without pause.
 */
const SAVE_PATIENCE_MS = 2_000;

interface FlashState {
  new: string[];
  old: string[];
}

/**
 * The session of the current request. Scoped: one per
 * request, injected into controllers, middleware and listeners alike.
 * `StartSession` loads it before the route and saves it afterwards.
 *
 * Values must survive `JSON.stringify` — a `Date` comes back as a string.
 */
export class Session {
  readonly #store: SessionStore;
  readonly #config: SessionConfig;
  readonly #codec: SessionCodec;
  #id = '';
  /** The store key of `#id` (its SHA-256) — made when first needed. */
  #key: string | undefined;
  #data: SessionPayload = {};
  #started = false;
  /** The session came from the store (it is not new in this request). */
  #loaded = false;
  /** The version the store had when the session was loaded — what a write back compares. */
  #version: number | undefined;
  /** The session's JSON as loaded: what this request changed is measured against it when a write back meets a conflict. */
  #base = EMPTY_PAYLOAD;
  /**
   * The stored session of this request's cookie is in a newer format: this request is a guest's and never touches that entry —
   * not written, and not destroyed unless this request signs in or out (`regenerate()`), which ends it for good: a copy of its
   * cookie must not outlive a sign-in or a sign-out.
   */
  #foreign = false;
  /** The id of that newer session, until `regenerate()` hands it to `save()` to destroy. */
  #foreignId: string | undefined;
  /** The last `save()` met concurrent writes on every attempt and gave up. */
  #abandoned = false;
  readonly #obsolete: string[] = [];
  /** Set for a read-only request (an island): asked before every write. */
  #permit: ((what: string) => boolean) | undefined;
  /** The flash messages this request took — put back by `reflash()` (a 409: the page is requested again). */
  #taken: FlashEntry[] = [];
  /** Something bound to this session was handed out (its CSRF token, a live subscription — `persist()`): a new session is kept. */
  #issued = false;
  /** The ids the last `save()` destroyed — a sign-in or sign-out ended them (their live streams close). */
  #ended: string[] = [];

  /** @internal Built by the container. */
  constructor(store: SessionStore, config: SessionConfig, codec: SessionCodec) {
    this.#store = store;
    this.#config = config;
    this.#codec = codec;
  }

  /** @internal Whether the session was started; read by the auth and page-protocol code. */
  get started(): boolean {
    return this.#started;
  }

  /**
   * @internal Whether this request may not change the session — an island's (`StartSession` locks it). Writes then throw in
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

  /** @internal The session's secret: never log it or key data by it — see sessionScope() in ended.ts. */
  get id(): string {
    this.#ensureStarted();
    return this.#id;
  }

  /**
   * Loads the session `id` (from the cookie) — looked up by its key, `sessionKey(id)` — or starts a new one if it is unknown,
   * expired or unreadable (an encrypted payload that does not decrypt).
   * @internal
   */
  async start(id?: string): Promise<void> {
    const key = id && SESSION_ID.test(id) ? sessionKey(id) : undefined;
    const stored = key ? await this.#store.read(key) : undefined;
    // The plain codec answers at once: awaited only when it is a promise (the encrypted codec) — a microtask less per request.
    const opened = stored ? this.#codec.open(stored.data, key!) : undefined;
    const json = opened instanceof Promise ? await opened : opened;
    const payload = json === undefined ? undefined : openPayload(json);
    const data = payload?.kind === 'ok' ? payload.data : undefined;
    this.#foreign = payload?.kind === 'foreign';
    this.#foreignId = this.#foreign ? id : undefined;
    if (data) {
      this.#id = id!;
      this.#key = key;
      this.#version = stored!.version;
      this.#base = json!;
    } else {
      this.#id = createSessionId();
      this.#key = undefined;
      this.#version = undefined;
      this.#base = EMPTY_PAYLOAD;
    }
    this.#data = data ?? {};
    this.#loaded = data !== undefined;
    this.#started = true;
    // No CSRF token yet: it is made when something needs it — `token()`, a page of a session that is kept, the
    // `XSRF-TOKEN` cookie. A guest's request that keeps no session never draws one.
  }

  /**
   * @internal — `StartSession` of an island the server resolves in-process while the page renders: a copy of the
   * page request's session as it is now — whoever it signed in, its flash data — never shared with it. The island's
   * session is read-only and never saved.
   */
  adopt(page: Session): void {
    // The page's token first (made on demand) — the island hands out the same one, never one of its own that is never saved.
    if (page.exists && !page.readOnly) page.#ensureToken();
    this.#id = page.id;
    this.#key = page.#key;
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
  flashData<K extends string>(key: K, value: Value<K>): void {
    const data = this.#ensureStarted();
    if (!this.#may(`session.flashData('${key}')`)) return;
    data[key] = value;
    const flash = this.#flash();
    flash.new = [...new Set([...flash.new, key])];
    flash.old = flash.old.filter((old) => old !== key);
  }

  /**
   * Keeps all flash data for one more request — and puts back the flash messages this request took: its answer is
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
   * Keeps a flash message (`redirect().flash()`) until a response the user is shown takes it — not aged by the
   * requests in between (a prefetch, an island, an API call).
   * @internal
   */
  queueFlash(message: FlashEntry): void {
    const data = this.#ensureStarted();
    if (!this.#may(`session.queueFlash('${message.key}')`)) return;
    data[MESSAGES] = [...((data[MESSAGES] as FlashEntry[] | undefined) ?? []), message].slice(-MAX_MESSAGES);
  }

  /**
   * The flash messages waiting, taken — by the response that delivers them. Nothing for a read-only request (an island,
   * a layer's base resolved in-process: they are not what the user is shown) or an unstarted session.
   * @internal
   */
  hasFlash(document?: string): boolean {
    return this.#started && ((this.#data[MESSAGES] as FlashEntry[] | undefined) ?? []).some((message) => mayTake(message, document));
  }

  /**
   * `document`: the document the request names — a message bound to another one (another tab's request flashed it) stays;
   * without one (a full page load), every message is taken.
   * @internal
   */
  takeFlash(document?: string): FlashEntry[] {
    if (!this.#started || this.#permit) return [];
    const waiting = (this.#data[MESSAGES] as FlashEntry[] | undefined) ?? [];
    const taken = waiting.filter((message) => mayTake(message, document));
    if (taken.length === 0) return [];
    const left = waiting.filter((message) => !taken.includes(message));
    if (left.length > 0) this.#data[MESSAGES] = left;
    else delete this.#data[MESSAGES];
    this.#taken.push(...taken);
    return taken;
  }

  /** Keeps some flash data for one more request. */
  keep(...keys: string[]): void {
    this.#ensureStarted();
    if (!this.#may(`session.keep('${keys.join("', '")}')`)) return;
    const flash = this.#flash();
    flash.new = [...new Set([...flash.new, ...keys])];
    flash.old = flash.old.filter((key) => !keys.includes(key));
  }

  /**
   * Flashes the request input, so the next page can refill the form (`old()`) — filtered like `redirect().withInput()`: it leaves
   * out every field that looks like a secret (a password, a token, a card detail, a one-time code, the names
   * `isSensitiveField` knows), the `_token` and every file. See `docs/responses.md#flash-data-and-flash-messages`.
   */
  flashInput(input: Record<string, unknown>): void {
    this.flashData(OLD_INPUT, flashableInput(input));
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
   * The CSRF token of this session — made the first time something needs it (a session that never hands one out never
   * draws one) and handed out: a new session whose token an app puts into a response itself is saved,
   * so the token is still valid when the browser sends it back. Pages do not need to: `PageObject.csrf` (what `<Form>`
   * renders) carries the token of a session that is kept anyway — a script reads the `XSRF-TOKEN` cookie with
   * `xsrfToken()` of `@marmeon/http/client` — and a guest's forms pass without one by the browser's word (Fetch
   * Metadata, Origin). So a guest's page creates no session.
   */
  token(): string {
    this.#ensureStarted();
    this.#issued = true;
    return this.#ensureToken();
  }

  /**
   * Keeps this session even with nothing in it — something the browser got is bound to it: its CSRF token (`token()`), a live
   * subscription a page signed. A guest's page that lets them upload files persists it too (an upload belongs to a
   * session). Nothing changes for a session that is kept anyway; a read-only request (an island) keeps none.
   */
  persist(): void {
    this.#ensureStarted();
    this.#issued = true;
  }

  /**
   * @internal — the token without handing it out (and without making one): what `VerifyCsrfToken` compares a request's
   * token against. `undefined` for a session that never needed one — no token matches it.
   */
  currentToken(): string | undefined {
    const token = this.#ensureStarted()[TOKEN];
    return typeof token === 'string' ? token : undefined;
  }

  /**
   * @internal Whether `save()` writes this session (and `StartSession` sends its cookie). Always for a session that came from the
   * store. A NEW session only once something is written: data, flash messages or errors (a failed form), a sign-in — or
   * something bound to it went out: its CSRF token handed out explicitly (`token()`), a live subscription (`persist()`). A
   * request that leaves nothing — a guest's page, a health check, an API call, a bot's redirect, a JSON endpoint that
   * never touches the session — leaves no session behind either (no row, no file, no cookie).
   */
  get persists(): boolean {
    const data = this.#ensureStarted();
    if (this.#permit || this.#foreign) return false;
    return this.#loaded || this.#issued || Object.keys(data).some((key) => key !== TOKEN && key !== FLASH);
  }

  /**
   * @internal Whether the session outlives this request: it came from the store, or this request keeps it (something was written or handed out). For a read-only
   * request (an island, a live stream, an upload) — which never keeps a new one — whether the session it reads exists.
   */
  get exists(): boolean {
    if (!this.#started) return false;
    return this.#loaded || (this.#permit === undefined && this.persists);
  }

  /** @internal A new CSRF token now — the old one stops matching (sign-in and sign-out do it through `regenerate()`). */
  regenerateToken(): void {
    const data = this.#ensureStarted();
    if (!this.#may('session.regenerateToken()')) return;
    data[TOKEN] = newToken();
  }

  /** The session's token — made now if it has none yet. Not a write the app asked for: no read-only check. */
  #ensureToken(): string {
    const data = this.#ensureStarted();
    const token = data[TOKEN];
    if (typeof token === 'string') return token;
    return (data[TOKEN] = newToken());
  }

  /**
   * A new id (and CSRF token) for the same data — after login, so an id planted
   * before cannot ride along (session fixation). The old id is destroyed on save.
   */
  regenerate(): void {
    this.#ensureStarted();
    if (!this.#may('session.regenerate()')) return;
    this.#obsolete.push(this.#id);
    if (this.#foreignId) this.#obsolete.push(this.#foreignId);
    this.#foreign = false;
    this.#foreignId = undefined;
    this.#id = createSessionId();
    this.#key = undefined;
    this.regenerateToken();
  }

  /** Ends the session: all data gone, new id, new token — for logout. */
  invalidate(): void {
    this.flush();
    this.regenerate();
  }

  // -- Persistence -----------------------------------------------------------

  /**
   * Ages flash data and writes the session (`StartSession` calls it after the route). Returns whether it wrote — false for a
   * read-only request, a new session with nothing worth keeping (`persists`), and a session another request destroyed meanwhile.
   * A loaded session is written back over the version it was loaded at (compare-and-set): a sign-out or sign-in that overtook
   * this request stays (`gone`) — writing the old session back would undo it. A `conflict` (another request wrote meanwhile) is
   * read again and merged ({@link mergeSession}). See `docs/session.md#how-sessions-are-stored`.
   * @internal
   */
  async save(): Promise<boolean> {
    this.#ensureStarted();
    this.#abandoned = false;
    // A read-only request never writes the session back: its flash data stays for the page it was meant for.
    // A newer format's session: left exactly as it is — nothing of this request is kept under it, and no cookie follows.
    if (this.#permit || this.#foreign) return false;
    const flash = this.#flash();
    for (const key of flash.old) delete this.#data[key];
    flash.old = flash.new;
    flash.new = [];
    if (flash.old.length === 0) delete this.#data[FLASH]; // nothing to age: no bookkeeping stored

    const lifetime = this.#config.lifetimeMinutes * 60;
    // The session this request loaded, under its key: written back over the version it was loaded at.
    if (this.#loaded && this.#obsolete.length === 0) return this.#writeBack(lifetime);
    // New, or regenerated (a new id): the old id goes, the new one is written — unless a new session holds nothing.
    this.#ended = this.#obsolete.splice(0);
    for (const id of this.#ended) await this.#store.destroy(sessionKey(id));
    if (!this.persists) return false;
    for (let attempt = 1; (await this.#write(undefined, lifetime)) !== 'written'; attempt++) {
      // The key is taken (an expired session's, or a 240-bit id that collided): another id — never over a stored session.
      if (attempt === 3) throw new Error('The session store keeps refusing new session keys — does its write() treat expectedVersion: undefined as "a new key"?');
      this.#id = createSessionId();
      this.#key = undefined;
    }
    return true;
  }

  /** Whether the last `save()` gave up: other requests wrote the session on every attempt. Nothing was written. @internal */
  get abandoned(): boolean {
    return this.#abandoned;
  }

  async #writeBack(lifetime: number): Promise<boolean> {
    const deadline = performance.now() + SAVE_PATIENCE_MS;
    for (let attempt = 1; ; attempt++) {
      const result = await this.#write(this.#version, lifetime);
      if (result === 'written') return true;
      if (result === 'gone') return false; // destroyed (signed out or in elsewhere) or expired: stays so
      // A conflict — another request wrote the session since it was loaded. Read it again, after a random moment.
      if (performance.now() > deadline) {
        this.#abandoned = true;
        return false;
      }
      await sleep(Math.random() * Math.min(2 ** attempt, 64));
      const stored = await this.#store.read(this.#key!);
      const json = stored ? await this.#codec.open(stored.data, this.#key!) : undefined;
      const payload = json === undefined ? undefined : openPayload(json);
      // Gone meanwhile — or rewritten in a format this release does not read (a newer process): not merged into, not overwritten.
      if (payload?.kind !== 'ok') return false;
      const theirs = payload.data;
      const base = this.#baseData();
      // Nothing changed here: the newer session already is what this request would write.
      if (isDeepStrictEqual(base, this.#data)) return true;
      this.#data = mergeSession(base, this.#data, theirs);
      this.#base = json!;
      this.#version = stored!.version;
    }
  }

  async #write(expectedVersion: number | undefined, lifetimeSeconds: number): Promise<SessionWriteResult> {
    const key = (this.#key ??= sessionKey(this.#id));
    const sealed = this.#codec.seal(sealPayload(this.#data), key);
    const data = sealed instanceof Promise ? await sealed : sealed;
    return this.#store.write(key, data, { expectedVersion, lifetimeSeconds, userId: userIdOf(this.#data) });
  }

  /** The ids the last `save()` destroyed: the session was regenerated (signed in) or invalidated (signed out). @internal */
  get ended(): readonly string[] {
    return this.#ended;
  }

  /** The payload this request loaded, without its mark. */
  #baseData(): SessionPayload {
    const opened = openPayload(this.#base);
    return opened.kind === 'ok' ? opened.data : {};
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

/** A CSRF token: 30 random bytes, base64url. */
function newToken(): string {
  return crypto.getRandomValues(new Uint8Array(30)).toBase64({ alphabet: 'base64url' });
}

/** Whether a request naming `document` takes `message`: one bound to no document, or to this one — or no document named. */
function mayTake(message: FlashEntry, document: string | undefined): boolean {
  return document === undefined || message.document === undefined || message.document === document;
}

/** The signed-in user's id as text (ids may be numbers or strings), or null for a guest — the `database` store's `user_id`. */
function userIdOf(data: SessionPayload): string | null {
  const id = data[SESSION_USER_KEY];
  return typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint' ? String(id) : null;
}

/**
 * Applies what one request changed (`ours`, against `base` — the session as it loaded it) to the session as another request
 * left it (`theirs`):
 *
 * - every key this request changed, added or removed: as this request has it — last write wins, key by key;
 * - every other key: as the other request left it;
 * - flash messages (`_flash_messages`) by their ids: the other request's list, minus the messages this request took
 *   (shown), plus the messages it added — none is lost, and none a faster request showed comes back;
 * - the flash bookkeeping (`_flash`): this request's, plus the keys the other request flashed.
 */
export function mergeSession(base: SessionPayload, ours: SessionPayload, theirs: SessionPayload): SessionPayload {
  const merged: SessionPayload = { ...theirs };
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (key === MESSAGES || key === FLASH || isDeepStrictEqual(base[key], ours[key])) continue;
    if (Object.hasOwn(ours, key)) merged[key] = ours[key];
    else delete merged[key];
  }

  const messages = (data: SessionPayload) => (Array.isArray(data[MESSAGES]) ? (data[MESSAGES] as FlashEntry[]) : []);
  const before = new Set(messages(base).map((message) => message.id));
  const kept = new Set(messages(ours).map((message) => message.id));
  const taken = new Set([...before].filter((id) => !kept.has(id)));
  const list = messages(theirs).filter((message) => !taken.has(message.id));
  const present = new Set(list.map((message) => message.id));
  for (const message of messages(ours)) if (!before.has(message.id) && !present.has(message.id)) list.push(message);
  if (list.length > 0) merged[MESSAGES] = list.slice(-MAX_MESSAGES);
  else delete merged[MESSAGES];

  const flash = (data: SessionPayload): FlashState => (data[FLASH] as FlashState | undefined) ?? { new: [], old: [] };
  const added = (side: 'new' | 'old') => flash(theirs)[side].filter((key) => !flash(base)[side].includes(key));
  const next = [...new Set([...flash(ours).new, ...added('new')])];
  const old = [...new Set([...flash(ours).old, ...added('old')])].filter((key) => !next.includes(key));
  if (next.length > 0 || old.length > 0) merged[FLASH] = { new: next, old } satisfies FlashState;
  else delete merged[FLASH];
  return merged;
}
