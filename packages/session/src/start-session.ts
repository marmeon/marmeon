import { Logger } from '@bespokecore/core';
import { LOCATION_HEADER, ReadOnly } from '@bespokecore/http';
import type { HttpContext, Next } from '@bespokecore/router';
import { SessionConfig } from './config.ts';
import { Session } from './session.ts';
import { SessionStore } from './store.ts';

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

  constructor(session: Session, config: SessionConfig, store: SessionStore, logger: Logger, readOnly: ReadOnly) {
    this.#session = session;
    this.#config = config;
    this.#store = store;
    this.#logger = logger;
    this.#readOnly = readOnly;
  }

  async handle(ctx: HttpContext, next: Next<{}>) {
    const { cookie, lifetime, secure, sameSite } = this.#config;
    await this.#session.start(ctx.cookies.get(cookie));
    if (this.#readOnly.active) {
      // An island (E52): it reads the session, never writes it — no save, no cookie, flash data stays for the page.
      this.#session.lock((what) => this.#readOnly.permit(what));
      return next();
    }
    try {
      const response = await next();
      // An asset-version reload (409): the page is requested again, so flash data must survive it.
      if (response.status === 409 && response.headers.has(LOCATION_HEADER)) this.#session.reflash();
      return response;
    } finally {
      // Not written back (a sign-out of the same browser overtook this request): no cookie either — the browser
      // keeps the one the sign-out sent.
      if (await this.#session.save()) ctx.cookies.set(cookie, this.#session.id, { maxAge: lifetime * 60, secure, sameSite });
    }
  }

  /** After the response: now and then, clean up expired sessions — the client does not wait for it. */
  async terminate(): Promise<void> {
    if (Math.random() >= this.#config.lottery) return;
    try {
      await this.#store.gc(this.#config.lifetime * 60);
    } catch (error) {
      this.#logger.warn('Session garbage collection failed', { exception: String(error) });
    }
  }
}
