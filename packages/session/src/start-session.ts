import { Logger } from '@bespokecore/core';
import type { HttpContext, Next } from '@bespokecore/router';
import { SessionConfig } from './config.ts';
import { Session } from './session.ts';
import { SessionStore } from './store.ts';

/** Share of requests that also clean up expired sessions (Laravel's lottery: 2 in 100). */
const GC_PROBABILITY = 0.02;

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

  constructor(session: Session, config: SessionConfig, store: SessionStore, logger: Logger) {
    this.#session = session;
    this.#config = config;
    this.#store = store;
    this.#logger = logger;
  }

  async handle(ctx: HttpContext, next: Next<{}>) {
    const { cookie, lifetime, secure, sameSite } = this.#config;
    await this.#session.start(ctx.cookies.get(cookie));
    try {
      return await next();
    } finally {
      await this.#session.save();
      ctx.cookies.set(cookie, this.#session.id, { maxAge: lifetime * 60, secure, sameSite });
      if (Math.random() < GC_PROBABILITY) {
        this.#store.gc(lifetime * 60).catch((error: unknown) => {
          this.#logger.warn('Session garbage collection failed', { exception: String(error) });
        });
      }
    }
  }
}
