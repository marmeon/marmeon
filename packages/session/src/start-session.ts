import { Container, Logger, Redactor } from '@marmeon/core';
import { ParentRequest, ReadOnly } from '@marmeon/http';
import { LOCATION_HEADER } from '@marmeon/http/internal';
import { HttpError, type HttpContext, type Next } from '@marmeon/router';
import { SessionConfig, sessionCookieName } from './config.ts';
import { sessionScope, SessionEndings } from './ended.ts';
import { Session } from './session.ts';
import { SESSION_ID, sessionKey, SessionStore } from './store.ts';

/**
 * The chance that a request cleans up expired sessions after its response: `SESSION_LOTTERY` — or 0
 * when the app's scheduler runs `session:prune` (then that is the one sweeper, not the requests).
 */
export class SessionLottery {
  chance: number;

  /** @internal Built by the container. */
  constructor(chance: number) {
    this.chance = chance;
  }
}

/**
 * Loads the session before the route and saves it afterwards — also when the
 * route throws, so flash data and a regenerated id are never lost. Sends the
 * session id as a cookie (encrypted by `EncryptCookies`, which must run first).
 */
export class StartSession {
  readonly #session: Session;
  readonly #config: SessionConfig;
  readonly #store: SessionStore;
  readonly #logger: Logger;
  readonly #readOnly: ReadOnly;
  readonly #parent: ParentRequest;
  readonly #lottery: SessionLottery;
  readonly #endings: SessionEndings;
  readonly #container: Container;

  /** @internal Built by the container. */
  constructor(
    session: Session,
    config: SessionConfig,
    store: SessionStore,
    logger: Logger,
    readOnly: ReadOnly,
    parent: ParentRequest,
    lottery: SessionLottery,
    endings: SessionEndings,
    container: Container,
  ) {
    this.#session = session;
    this.#config = config;
    this.#store = store;
    this.#logger = logger;
    this.#readOnly = readOnly;
    this.#parent = parent;
    this.#lottery = lottery;
    this.#endings = endings;
    this.#container = container;
  }

  async handle(ctx: HttpContext, next: Next<{}>) {
    const { secure, sameSite } = this.#config;
    const cookie = sessionCookieName(this.#config);
    if (this.#readOnly.active) {
      // An island resolved while its page renders reads the page request's session as it is now — whoever the page
      // signed in (a remember-me sign-in included, which the cookie does not know yet) — as a copy.
      const page = this.#parent.resolve(Session);
      if (page?.started) this.#session.adopt(page);
      else await this.#session.start(ctx.cookies.get(cookie));
      // An island: it reads the session, never writes it — no save, no cookie, flash data stays for the page.
      this.#session.lock((what) => this.#readOnly.permit(what));
      return next();
    }
    const id = ctx.cookies.get(cookie);
    // A route that blocks: one request of this session at a time — from before it is read until it is saved.
    const lock = ctx.route?.blocking ? await this.#block(ctx, id) : undefined;
    try {
      await this.#session.start(id);
      try {
        const response = await next();
        // An asset-version reload (409): the page is requested again, so flash data must survive it.
        if (response.status === 409 && response.headers.has(LOCATION_HEADER)) this.#session.reflash();
        return response;
      } finally {
        // Not written back (a sign-out of the same browser overtook this request): no cookie either — the browser
        // keeps the one the sign-out sent.
        // No Max-Age: the browser drops the cookie when it closes; the store's lifetime ends the session on the server either way.
        if (await this.#session.save()) ctx.cookies.set(cookie, this.#session.id, { secure, sameSite });
        else if (this.#session.abandoned) {
          this.#logger.warn('The session was not saved: other requests of the same session wrote it on every attempt — Route.block() serialises such a route', {
            route: ctx.route?.routeName ?? ctx.route?.path,
          });
        }
        // Signed in or out: the old session is gone — whoever listened through it stops (its live streams, everywhere).
        for (const ended of this.#session.ended) await this.#endings.ended(sessionScope(ended));
        // Saved: nothing that still runs in this request — a streamed page's deferred props — reaches the store any
        // more. Once the headers are out, the kernel makes the request read-only, and a write throws (or is dropped).
        this.#session.lock((what) => this.#readOnly.permit(what));
      }
    } finally {
      await lock?.release();
    }
  }

  /**
   * The session's lock for a route that `block()`s — taken before the session is read, through the app's cache (atomic
   * locks), keyed by the session's store key (never its id). Nothing to lock without a session cookie: a new session is
   * nobody else's.
   */
  async #block(ctx: HttpContext, id: string | undefined): Promise<{ release(): Promise<boolean> } | undefined> {
    const blocking = ctx.route?.blocking;
    if (!blocking || !id || !SESSION_ID.test(id)) return undefined;
    const cache = await import('@marmeon/cache').catch(() => undefined);
    if (!cache || !this.#container.has(cache.Cache)) {
      throw new Error(`Route ${ctx.route.path} uses block(): that needs the cache's atomic locks — install @marmeon/cache (pnpm add @marmeon/cache).`);
    }
    const lock = this.#container.make(cache.Cache).lock(`session:${sessionKey(id)}`, blocking.lockSeconds);
    try {
      await lock.block(blocking.waitSeconds);
    } catch (error) {
      if (!(error instanceof cache.LockTimeoutError)) throw error;
      // Busy longer than the route waits: 423 Locked — the browser may try again. The error page may read the session (who is
      // signed in), never write it.
      await this.#session.start(id);
      this.#session.lock((what) => this.#readOnly.permit(what));
      throw new HttpError(423, undefined, { 'retry-after': String(Math.ceil(blocking.lockSeconds)) });
    }
    return lock;
  }

  /** After the response: now and then, clean up expired sessions — the client does not wait for it. */
  async terminate(): Promise<void> {
    if (Math.random() >= this.#lottery.chance) return;
    try {
      await this.#store.gc(this.#config.lifetimeMinutes * 60);
    } catch (error) {
      // Masked by the app's Redactor: the names its packages add (this one's cookie) count too.
      const redactor = this.#container.has(Redactor) ? this.#container.make(Redactor) : new Redactor();
      this.#logger.warn('Session garbage collection failed', { exception: redactor.text(String(error)) });
    }
  }
}
