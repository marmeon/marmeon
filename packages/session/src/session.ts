import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Redactor } from '@marmeon/core';
import type { ValidationErrors } from '@marmeon/http';
import { flashableInput, OLD_INPUT_KEY, type FlashEntry, type SentBack } from '@marmeon/http/internal';
import { SessionCodec } from './codec.ts';
import { SessionConfig } from './config.ts';
import { EMPTY_PAYLOAD, openPayload, sealPayload } from './format.ts';
import { createSessionId, isSessionIdentityKey, SESSION_ID, SESSION_USER_KEY, sessionKey, SessionStore, type SessionPayload, type SessionWriteResult } from './store.ts';

/**
 * Typed session keys, declared by apps and packages through declaration merging:
 * `declare module '@marmeon/session' { interface SessionData { user_id: string } }`. Declared keys are checked
 * (`put('user_id', 1)` is an error); other keys are `unknown`.
 */
export interface SessionData {
  /** Validation errors flashed by a failed page request — read through the `errors` prop, not here (`docs/session.md#flash-data`). */
  errors: ValidationErrors;
}

type Value<K extends string> = K extends keyof SessionData ? SessionData[K] : unknown;

/** `value` without any field, at any depth, named `__proto__` or whose name `redactor` was given (exact, case-insensitive); arrays are walked. */
function withoutAddedKeys(given: unknown, redactor: Redactor | undefined): unknown {
  // Like the JSON the store writes: a `Date` is its string, not an object without entries.
  const value = typeof (given as { toJSON?: unknown } | null)?.toJSON === 'function' ? (given as { toJSON(): unknown }).toJSON() : given;
  if (Array.isArray(value)) return value.map((item) => withoutAddedKeys(item, redactor));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== '__proto__' && !redactor?.isAddedKey(name)).map(([name, item]) => [name, withoutAddedKeys(item, redactor)]));
}

const FLASH = '_flash';
/** Flash messages waiting for a response that is shown. */
const MESSAGES = '_flash_messages';
/**
 * The records of forms sent back — a session key of their own, never among the flash messages: an instance of the release before
 * keeps an unknown key as it is and hands out only `_flash_messages`, which it would send to the browser.
 */
const RECORDS = '_sent_back';
/** The flash keys (`errors`, `_old_input`) a queued record of a form sent back mirrors: flash data that ages with them. */
const MIRRORED = '_flash_mirrored';
/** The flash keys a record of a form sent back can mirror. */
const MIRRORABLE: readonly string[] = ['errors', OLD_INPUT_KEY];
// `_flash_mirrored` is `{ [flash key]: generation }`.
/** At most this many wait: an app that never shows them does not grow the session without end (the oldest go). */
const MAX_MESSAGES = 20;
/** The records of forms sent back that may wait at once in one session: one per document and submit. */
const MAX_SENT_BACK = 10;
/**
 * How long a record of a form sent back waits for its page: five minutes. The follow-up of a submit comes within a round trip
 * (seconds), a form without JavaScript is loaded again by the same browser at once; five minutes cover a slow network or a tab
 * that was frozen, and a follow-up that never comes cannot keep up to 64 KiB of errors and input in a session for its whole lifetime.
 */
const SENT_BACK_LIFETIME_MS = 5 * 60_000;
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
  #readAt: number | undefined;
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
  /** Its added names keep their fields out of the flashed input. */
  readonly #redactor: Redactor | undefined;
  /** Set by `expectSentBack()`: this request is a page the user is shown, and takes what a form was sent back with for this document and submit. */
  #expectedSentBack: { readonly document: string | undefined; readonly submit: string | undefined } | undefined;
  /** What this request took of it (taken once, on the first `sentBack()`). */
  #sentBack: { readonly value: SentBack | undefined } | undefined;
  /** The flash messages this request took — put back by `reflash()` (a 409: the page is requested again). */
  #taken: FlashEntry[] = [];
  /** The records this request took — put back by `reflash()` too. */
  #takenRecords: FlashEntry[] = [];
  /** The flash keys this request flashed — a write back that meets another request's counts each as changed, even when it equals what was loaded. */
  readonly #flashedKeys = new Set<string>();
  /** Something bound to this session was handed out (its CSRF token, a live subscription — `persist()`): a new session is kept. */
  #issued = false;
  /** The ids the last `save()` destroyed — a sign-in or sign-out ended them (their live streams close). */
  #ended: string[] = [];

  /** @internal Built by the container. */
  constructor(store: SessionStore, config: SessionConfig, codec: SessionCodec, redactor?: Redactor) {
    this.#redactor = redactor;
    this.#store = store;
    this.#config = config;
    this.#codec = codec;
  }

  /** @internal Whether the session was started; read by the auth and page-protocol code. */
  get started(): boolean {
    return this.#started;
  }

  /**
   * Whether this request may not change the session — an island, a live validation, an upload, an event stream, the session's
   * epoch check or a page rendered as a layer's base, which run beside the page, and work a page does after its session is saved. Code that runs for those too, such as a route's `afterAuthorize` hook, checks it before a write: a write then throws in
   * development and is dropped in production, and the session is never saved.
   * See docs/session.md#requests-that-only-read.
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
   * When `start()` began to read the session (ms on the clock of `performance.timeOrigin + performance.now()`), undefined before.
   * @internal
   */
  get readAt(): number | undefined {
    return this.#readAt;
  }

  /**
   * Loads the session `id` (from the cookie) — looked up by its key, `sessionKey(id)` — or starts a new one if it is unknown,
   * expired or unreadable (an encrypted payload that does not decrypt).
   * @internal
   */
  async start(id?: string): Promise<void> {
    // Before the store is read: an end of this session that arrives later may not be known to what is read.
    this.#readAt = performance.timeOrigin + performance.now();
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
    // A record whose follow-up never came is gone: the session is not read and written back with it on every request.
    if (Array.isArray(this.#data[RECORDS])) {
      const live = capRecords(this.#data[RECORDS] as FlashEntry[]);
      if (live.length > 0) this.#data[RECORDS] = live;
      else delete this.#data[RECORDS];
    }
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
    // What a form was sent back with is taken by the page, once — before the copy, so the island does not hold it again; the island reads the same record.
    this.#sentBack = page.#expectedSentBack !== undefined && page.#started ? { value: structuredClone(page.sentBack()) } : undefined;
    this.#expectedSentBack = page.#expectedSentBack;
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

  /**
   * The keys holding the id of a signed-in user (one per guard that signed somebody in), sorted, the app guard's first.
   * @internal For the tab-sync epoch and no-store: a sign-in of any guard counts.
   */
  identityKeys(): string[] {
    const keys = Object.keys(this.#ensureStarted()).filter(isSessionIdentityKey);
    return keys.sort((a, b) => (a === SESSION_USER_KEY ? -1 : b === SESSION_USER_KEY ? 1 : a < b ? -1 : a > b ? 1 : 0));
  }

  /** Everything except the framework's bookkeeping (`_token`, `_flash`, …). */
  all(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.#ensureStarted()).filter(([key]) => !key.startsWith('_')));
  }

  /** Removes all data, the CSRF token included. */
  flush(): void {
    this.#ensureStarted();
    if (!this.#may('session.flush()')) return;
    this.#data = {};
    // What this request took of the data that is gone is gone with it: not shown by `old()`, not put back by `reflash()`.
    this.#sentBack = { value: undefined };
    this.#taken = [];
    this.#takenRecords = [];
  }

  // -- Flash data ------------------------------------------------------------

  /** Stores a value for this and the next request only. */
  flashData<K extends string>(key: K, value: Value<K>): void {
    const data = this.#ensureStarted();
    if (!this.#may(`session.flashData('${key}')`)) return;
    // Here, where every way of flashing input arrives: a `__proto__` field never stays, and a field whose name the app (or a package) added to the redactor never
    // reaches the store, `old()` or the next page's props. The core's own list is for the browser's and the log's sake, not this.
    const redactor = this.#redactor;
    data[key] = key === OLD_INPUT ? withoutAddedKeys(value, redactor?.hasAddedKeys ? redactor : undefined) : value;
    this.#flashedKeys.add(key);
    // A value flashed now is the controller's own, not a copy of a record: shown, whatever an earlier record mirrored under that key.
    const mirrored = data[MIRRORED] as Record<string, string> | undefined;
    if (mirrored !== undefined && Object.hasOwn(mirrored, key)) {
      const { [key]: _own, ...rest } = mirrored;
      if (Object.keys(rest).length > 0) data[MIRRORED] = rest;
      else delete data[MIRRORED];
    }
    const flash = this.#flash();
    flash.new = [...new Set([...flash.new, key])];
    flash.old = flash.old.filter((old) => old !== key);
  }

  /**
   * What this request flashed under `key` (`flashData()`, `flashInput()`, a redirect's `with()`), `undefined` when it flashed nothing.
   * @internal
   */
  flashed(key: string): unknown {
    const data = this.#ensureStarted();
    return this.#flashedHere(key) && Object.hasOwn(data, key) ? data[key] : undefined;
  }

  /** Whether this request flashed `key` — read without creating the bookkeeping. */
  #flashedHere(key: string): boolean {
    return ((this.#ensureStarted()[FLASH] as FlashState | undefined)?.new ?? []).includes(key);
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
      this.#ensureStarted()[MESSAGES] = capMessages([...this.#taken, ...waiting]);
      this.#taken = [];
    }
    if (this.#takenRecords.length > 0) {
      this.#setRecords(capRecords([...this.#takenRecords, ...this.#records()]));
      this.#takenRecords = [];
    }
  }

  /**
   * Keeps a flash message (`redirect().flash()`) until a response the user is shown takes it — not aged by the
   * requests in between (a prefetch, an island, an API call). What a refused form is sent back with is no message:
   * {@link queueSentBack}.
   * @internal
   */
  queueFlash(message: FlashEntry): void {
    const data = this.#ensureStarted();
    if (!this.#may(`session.queueFlash('${message.key}')`)) return;
    data[MESSAGES] = capMessages([...((data[MESSAGES] as FlashEntry[] | undefined) ?? []), message]);
  }

  /**
   * Keeps the record of a refused form (its {@link SentBack}, in `data`) until the page of its submit takes it: in a session key of
   * its own, apart from the flash messages. The plain copies of its errors and input that this request flashed are marked as
   * mirrored, and shown by no other request.
   * @internal
   */
  queueSentBack(message: FlashEntry): void {
    this.#ensureStarted();
    if (!this.#may('session.queueSentBack()')) return;
    // Like `flashData()` for `_old_input`: a field whose name the app added to the redactor never reaches the store, in the record of a form sent back either.
    const redactor = this.#redactor?.hasAddedKeys ? this.#redactor : undefined;
    const input = (message.data as { input?: unknown } | null)?.input;
    const stamped = { ...message, at: message.at ?? Date.now() };
    const kept = redactor !== undefined && typeof input === 'object' && input !== null ? { ...stamped, data: { ...(message.data as object), input: withoutAddedKeys(input, redactor) } } : stamped;
    this.#setRecords(capRecords([...this.#records(), kept]));
    const record = sentBackOf(message.data);
    this.#mirror([...(record?.errors !== undefined && this.#flashedHere('errors') ? ['errors'] : []), ...(record?.input !== undefined && this.#flashedHere(OLD_INPUT) ? [OLD_INPUT] : [])]);
  }

  /** The records of forms sent back that wait (a session key of their own, not the flash messages). */
  #records(): FlashEntry[] {
    const list = this.#ensureStarted()[RECORDS];
    return Array.isArray(list) ? (list as FlashEntry[]) : [];
  }

  #setRecords(list: FlashEntry[]): void {
    if (list.length > 0) this.#ensureStarted()[RECORDS] = list;
    else delete this.#ensureStarted()[RECORDS];
  }

  /**
   * The flash messages waiting, taken — by the response that delivers them. Nothing for a read-only request (an island,
   * a layer's base resolved in-process: they are not what the user is shown) or an unstarted session.
   * @internal
   */
  hasFlash(document?: string): boolean {
    // A waiting record of a form sent back counts when any page of the document takes it — also one bound to a submit: a prefetch
    // must not stand in for that page, nor be kept as one that has none.
    const now = Date.now();
    return this.#started && (((this.#data[MESSAGES] as FlashEntry[] | undefined) ?? []).some((message) => mayTake(message, document)) || this.#records().some((message) => mayTake(message, document) && !expired(message, now)));
  }

  /**
   * `document`: the document the request names — a message bound to another one (another tab's request flashed it) stays;
   * without one (a full page load), every message is taken.
   * @internal
   */
  takeFlash(document?: string): FlashEntry[] {
    if (!this.#started || this.#permit) return [];
    const waiting = (this.#data[MESSAGES] as FlashEntry[] | undefined) ?? [];
    return this.#takeMessages(waiting.filter((message) => mayTake(message, document)));
  }

  /**
   * What a form was sent back with — its validation errors, its input for `old()`, the conflict of a stale save — taken by the page of
   * the document that sent it: a prefetch, an island or another tab's request leaves it waiting. Only the parts of the right shape
   * count (`errors` a record of string lists, `input` an object, `conflict` `{ message, current? }`); an entry with none counts as none.
   * Nothing for a read-only request or an unstarted session. `document`: as for {@link takeFlash}.
   * `submit`: the id the request carries (`x-marmeon-submit`). A record bound to the submit that was answered with it is taken by the
   * request that carries that id only — not by a poll or a partial reload of the same document; one without an id (a form
   * without JavaScript) follows the rule of `document`.
   * @internal
   */
  takeSentBack(document?: string, submit?: string): SentBack | undefined {
    if (!this.#started || this.#permit) return undefined;
    const now = Date.now();
    const matches = this.#records().filter((message) => !expired(message, now) && mayTake(message, document) && (message.form === undefined || message.form === submit));
    // The one made for this submit, else the newest that follows the rule of the document: another form's waiting record stays.
    const own = matches.findLast((message) => message.form !== undefined) ?? matches.at(-1);
    return sentBackOf(this.#takeRecords(own ? [own] : []).at(0)?.data);
  }

  /** @internal — ShareErrorsFromSession: this request is a page the user is shown; what a form was sent back with is taken on first read. */
  expectSentBack(document: string | undefined, submit: string | undefined): void {
    this.#expectedSentBack = { document, submit };
  }

  /** @internal — the record this request took (taken on the first call, then the same), undefined when it takes none. */
  sentBack(): SentBack | undefined {
    const expected = this.#expectedSentBack;
    if (expected === undefined) return undefined;
    this.#sentBack ??= { value: this.takeSentBack(expected.document, expected.submit) };
    return this.#sentBack.value;
  }

  /**
   * The record of `submit` loses its binding to it: its follow-up became a full document load (an asset-version 409), which carries no
   * submit id — from then on the rule of `document` (or a full load) applies. Replaced by a new entry (a new id), not changed in place:
   * a concurrent write merges messages by id, and would bring the binding back to an entry that kept its own.
   * @internal
   */
  releaseSentBack(document: string | undefined, submit: string): void {
    if (!this.#started || this.#permit) return;
    const waiting = this.#records();
    if (!waiting.some((message) => message.form === submit && message.document === document)) return;
    this.#setRecords(capRecords(waiting.map((message) => (message.form === submit && message.document === document ? { id: crypto.randomUUID(), key: message.key, data: message.data, ...(message.at !== undefined ? { at: message.at } : {}), ...(document !== undefined ? { document } : {}) } : message))));
  }

  /**
   * A submit of `document` that is not the one a record waits for ends it: what a form was sent back with never lands on the page of another form.
   * Nothing for a read-only request, an unstarted session or a submit that names no document.
   * @internal
   */
  dropSentBack(document: string | undefined, submit: string): void {
    if (!this.#started || this.#permit || document === undefined) return;
    const waiting = this.#records();
    const stale = waiting.filter((message) => message.document === document && message.form !== submit);
    if (stale.length === 0) return;
    this.#setRecords(waiting.filter((message) => !stale.includes(message)));
  }

  #takeRecords(taken: FlashEntry[]): FlashEntry[] {
    if (taken.length === 0) return [];
    this.#setRecords(this.#records().filter((message) => !taken.includes(message)));
    this.#takenRecords.push(...taken);
    return taken;
  }

  #takeMessages(taken: FlashEntry[]): FlashEntry[] {
    if (taken.length === 0) return [];
    const waiting = (this.#data[MESSAGES] as FlashEntry[] | undefined) ?? [];
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
    // A copy that a record mirrors keeps its mark: the mark ages with it, so no other request shows it later.
    const marked = (this.#ensureStarted()[MIRRORED] as Record<string, string> | undefined) ?? {};
    const kept = keys.some((key) => Object.hasOwn(marked, key)) ? [...keys, MIRRORED] : keys;
    flash.new = [...new Set([...flash.new, ...kept])];
    flash.old = flash.old.filter((key) => !kept.includes(key));
  }

  /**
   * Flashes the request input, so the next page can refill the form (`old()`) — filtered like `redirect().withInput()`: it leaves
   * out every field that looks like a secret (a password, a token, a card detail, a one-time code, the names
   * `isSensitiveField` knows), the `_token` and every file. See `docs/responses.md#flash-data-and-flash-messages`.
   */
  flashInput(input: Record<string, unknown>): void {
    this.flashData(OLD_INPUT, flashableInput(input));
  }

  /**
   * The input a form was sent back with — all of it, or one field: what the request itself flashed, else the record the page of the
   * submit took, else the plain flash data of the previous request — unless a record of a form sent back mirrors that copy (it is
   * shown by the page of the submit alone). See `docs/session.md#flash-data`.
   */
  old(): Record<string, unknown>;
  old(key: string): unknown;
  old(key?: string): unknown {
    const input = this.#shown(OLD_INPUT, 'input') ?? {};
    return key === undefined ? input : Object.hasOwn(input, key) ? input[key] : undefined;
  }

  /**
   * The validation errors this request shows, chosen as for {@link old}: what it flashed itself, else the record it took, else the
   * plain flash data of the previous request that no record mirrors. An object, `{}` for anything else.
   * @internal
   */
  shownErrors(): Record<string, string[]> {
    const shown = this.#shown('errors', 'errors');
    return isPlainObject(shown) ? shown : {};
  }

  /** The value of `part` this request shows — see {@link shownErrors}; `undefined` when there is none. */
  #shown<K extends 'errors' | 'input'>(plainKey: string, part: K): SentBack[K] | undefined {
    const fresh = this.#flashedHere(plainKey) ? this.#plain(plainKey) : undefined;
    if (fresh !== undefined) return fresh as SentBack[K];
    const taken = this.sentBack()?.[part];
    if (taken !== undefined) return taken;
    return this.#plain(plainKey) as SentBack[K] | undefined;
  }

  /** The plain flash data under `key`, unless a record of a form sent back mirrors it: only that record's page shows it. */
  #plain(key: string): unknown {
    const data = this.#ensureStarted();
    const mirrored = (data[MIRRORED] as Record<string, string> | undefined) ?? {};
    return Object.hasOwn(data, key) && !Object.hasOwn(mirrored, key) ? data[key] : undefined;
  }

  /** The plain copies `keys` are mirrored by a record just queued: they age with it (a flash key of their own), and are not shown. */
  #mirror(keys: string[]): void {
    if (keys.length === 0) return;
    const data = this.#ensureStarted();
    const mirrored = (data[MIRRORED] as Record<string, string> | undefined) ?? {};
    // A fresh generation for every copy: a concurrent request that aged the mark away cannot make a merge lose it (an unchanged value would be skipped).
    data[MIRRORED] = { ...mirrored, ...Object.fromEntries(keys.map((key) => [key, crypto.randomUUID()])) };
    const flash = this.#flash();
    flash.new = [...new Set([...flash.new, MIRRORED])];
    flash.old = flash.old.filter((old) => old !== MIRRORED);
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
      this.#data = mergeSession(base, this.#data, theirs, this.#flashedKeys);
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

/** The flash messages as the session keeps them: the newest {@link MAX_MESSAGES}. */
function capMessages(list: readonly FlashEntry[]): FlashEntry[] {
  return list.slice(-MAX_MESSAGES);
}

/**
 * The records of forms sent back as the session keeps them: the newest of each document and submit, at most {@link MAX_SENT_BACK} of
 * them, the oldest dropped first, and none past its lifetime. One tab's cannot erase another's, and a run of refused posts cannot
 * grow the session.
 */
function capRecords(list: readonly FlashEntry[]): FlashEntry[] {
  const newest = new Map<string, FlashEntry>();
  const now = Date.now();
  for (const message of list) {
    if (expired(message, now)) continue;
    const slot = JSON.stringify([message.document ?? null, message.form ?? null]);
    // Re-inserted: the map keeps the order of the newest write.
    newest.delete(slot);
    newest.set(slot, message);
  }
  return [...newest.values()].slice(-MAX_SENT_BACK);
}

/** A record of a form sent back that waited longer than {@link SENT_BACK_LIFETIME_MS} (one without a time counts as such). */
function expired(message: FlashEntry, now: number): boolean {
  return typeof message.at !== 'number' || now - message.at > SENT_BACK_LIFETIME_MS;
}

/** What a form was sent back with, as the session may hold it — each part validated, never cast: a part of the wrong shape is dropped, an entry with no part is none. */
function sentBackOf(value: unknown): SentBack | undefined {
  if (!isPlainObject(value)) return undefined;
  const { errors, input } = value as { errors?: unknown; input?: unknown };
  const kept: { errors?: Record<string, string[]>; input?: Record<string, unknown>; conflict?: { readonly message: string; readonly current?: unknown } } = {};
  if (isPlainObject(errors) && Object.values(errors).every((list) => Array.isArray(list) && list.every((item) => typeof item === 'string'))) kept.errors = Object.fromEntries(Object.entries(errors).map(([field, list]) => [field, [...(list as string[])]]));
  if (isPlainObject(input)) kept.input = input;
  const conflict = Object.hasOwn(value, 'conflict') ? conflictOf((value as { conflict: unknown }).conflict) : undefined;
  if (conflict !== undefined) kept.conflict = conflict;
  return Object.keys(kept).length > 0 ? kept : undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{ message, current? }` as the session may hold it — validated, never cast: anything else is no conflict. */
function conflictOf(value: unknown): { readonly message: string; readonly current?: unknown } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { message } = value as { message?: unknown };
  if (typeof message !== 'string') return undefined;
  return { message, ...(Object.hasOwn(value, 'current') ? { current: (value as { current: unknown }).current } : {}) };
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
 * - flash messages (`_flash_messages`) and the records of forms sent back (`_sent_back`), each by their ids: the other request's list, minus the messages this request took
 *   (shown), plus the messages it added — none is lost, and none a faster request showed comes back;
 * - a flash copy that a record mirrors (`errors`, `_old_input`) with its mark, as one unit: this request's if it flashed, marked or unmarked
 *   it (`flashed`: the keys it flashed — an identical value counts), else the other request's;
 * - the flash bookkeeping (`_flash`): this request's, plus the keys the other request flashed.
 */
export function mergeSession(base: SessionPayload, ours: SessionPayload, theirs: SessionPayload, flashed: ReadonlySet<string> = new Set()): SessionPayload {
  const merged: SessionPayload = { ...theirs };
  for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (key === MESSAGES || key === RECORDS || key === MIRRORED || MIRRORABLE.includes(key) || key === FLASH || isDeepStrictEqual(base[key], ours[key])) continue;
    if (Object.hasOwn(ours, key)) merged[key] = ours[key];
    else delete merged[key];
  }

  // A mirrored copy merges together with its mark, as one unit: if this request changed either (flashed anew, marked, unmarked, aged
  // away), the other request's value and mark both give way to this request's; if not, both stay as the other request left them. A mark
  // never outlives its value, and a value another request just replaced never loses its mark to an older generation.
  const marks = (data: SessionPayload) => (typeof data[MIRRORED] === 'object' && data[MIRRORED] !== null ? (data[MIRRORED] as Record<string, string>) : {});
  const mergedMarks = { ...marks(theirs) };
  for (const name of MIRRORABLE) {
    if (!flashed.has(name) && isDeepStrictEqual(base[name], ours[name]) && marks(base)[name] === marks(ours)[name]) continue;
    if (Object.hasOwn(ours, name)) merged[name] = ours[name];
    else delete merged[name];
    if (Object.hasOwn(marks(ours), name)) mergedMarks[name] = marks(ours)[name]!;
    else delete mergedMarks[name];
  }
  if (Object.keys(mergedMarks).length > 0) merged[MIRRORED] = mergedMarks;
  else delete merged[MIRRORED];

  // Both lists merge by id: the messages and the records of forms sent back.
  for (const [key, cap] of [[MESSAGES, capMessages], [RECORDS, capRecords]] as const) {
    const entries = (data: SessionPayload) => (Array.isArray(data[key]) ? (data[key] as FlashEntry[]) : []);
    const before = new Set(entries(base).map((message) => message.id));
    const kept = new Set(entries(ours).map((message) => message.id));
    const taken = new Set([...before].filter((id) => !kept.has(id)));
    const list = entries(theirs).filter((message) => !taken.has(message.id));
    const present = new Set(list.map((message) => message.id));
    for (const message of entries(ours)) if (!before.has(message.id) && !present.has(message.id)) list.push(message);
    const capped = cap(list);
    if (capped.length > 0) merged[key] = capped;
    else delete merged[key];
  }

  const flash = (data: SessionPayload): FlashState => (data[FLASH] as FlashState | undefined) ?? { new: [], old: [] };
  const added = (side: 'new' | 'old') => flash(theirs)[side].filter((key) => !flash(base)[side].includes(key));
  const next = [...new Set([...flash(ours).new, ...added('new')])];
  const old = [...new Set([...flash(ours).old, ...added('old')])].filter((key) => !next.includes(key));
  if (next.length > 0 || old.length > 0) merged[FLASH] = { new: next, old } satisfies FlashState;
  else delete merged[FLASH];
  return merged;
}
