import { Logger } from '@bespokecore/core';
import { LOCATION_HEADER, ParentRequest, ReadOnly } from '@bespokecore/http';
import type { HttpContext, Next } from '@bespokecore/router';
import { SessionConfig } from './config.ts';
import { sessionScope, SessionEndings } from './ended.ts';
import { Session } from './session.ts';
import { SessionStore } from './store.ts';

/**
 * The chance that a request cleans up expired sessions after its response (Laravel's lottery): `SESSION_LOTTERY` — or 0
 * when the app's scheduler runs `session:prune` (then that is the one sweeper, not the requests).
 */
export class SessionLottery {
  chance: number;

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

  constructor(
    session: Session,
    config: SessionConfig,
    store: SessionStore,
    logger: Logger,
    readOnly: ReadOnly,
    parent: ParentRequest,
    lottery: SessionLottery,
    endings: SessionEndings,
  ) {
    this.#session = session;
    this.#config = config;
    this.#store = store;
    this.#logger = logger;
    this.#readOnly = readOnly;
    this.#parent = parent;
    this.#lottery = lottery;
    this.#endings = endings;
  }

  async handle(ctx: HttpContext, next: Next<{}>) {
    const { cookie, lifetime, secure, sameSite } = this.#config;
    if (this.#readOnly.active) {
      // An island resolved while its page renders (E49) reads the page request's session as it is now — whoever the page
      // signed in (a remember-me sign-in included, which the cookie does not know yet) — as a copy.
      const page = this.#parent.resolve(Session);
      if (page?.started) this.#session.adopt(page);
      else await this.#session.start(ctx.cookies.get(cookie));
      // An island (E52): it reads the session, never writes it — no save, no cookie, flash data stays for the page.
      this.#session.lock((what) => this.#readOnly.permit(what));
      return next();
    }
    await this.#session.start(ctx.cookies.get(cookie));
    try {
      const response = await next();
      // An asset-version reload (409): the page is requested again, so flash data must survive it.
      if (response.status === 409 && response.headers.has(LOCATION_HEADER)) this.#session.reflash();
      return response;
    } finally {
      // Not written back (a sign-out of the same browser overtook this request): no cookie either — the browser
      // keeps the one the sign-out sent.
      if (await this.#session.save()) ctx.cookies.set(cookie, this.#session.id, { maxAge: lifetime * 60, secure, sameSite });
      // Signed in or out: the old session is gone — whoever listened through it stops (W6.10: its live streams, everywhere).
      for (const id of this.#session.ended) await this.#endings.ended(sessionScope(id));
      // Saved: nothing that still runs in this request — a streamed page's deferred props (E49) — reaches the store any
      // more. Once the headers are out, the kernel makes the request read-only, and a write throws (or is dropped).
      this.#session.lock((what) => this.#readOnly.permit(what));
    }
  }

  /** After the response: now and then, clean up expired sessions — the client does not wait for it. */
  async terminate(): Promise<void> {
    if (Math.random() >= this.#lottery.chance) return;
    try {
      await this.#store.gc(this.#config.lifetime * 60);
    } catch (error) {
      this.#logger.warn('Session garbage collection failed', { exception: String(error) });
    }
  }
}
