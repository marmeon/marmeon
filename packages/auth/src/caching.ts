import { editableResponse, type HttpContext, type Next } from '@marmeon/router';
import { Session } from '@marmeon/session';
import { AUTH_SESSION_KEYS } from './auth.ts';

/** What a response for a signed-in user may be kept as: nowhere — not in the HTTP cache, not on a proxy. */
export const NO_STORE = 'no-store, private';

/**
 * Answers for a signed-in user are never stored (`Cache-Control: no-store, private`), so "Back" after signing out cannot
 * show them from the HTTP cache (Chromium keeps `no-store` pages out of the back/forward cache too). Asks the session, never
 * loads the user; a route that sets its own `Cache-Control` keeps it. See
 * `docs/authentication.md#signed-in-pages-are-never-cached`.
 */
export class NoStoreWhenSignedIn {
  readonly #session: Session;

  /** @internal Built by the container. */
  constructor(session: Session) {
    this.#session = session;
  }

  async handle(_ctx: HttpContext, next: Next<{}>): Promise<Response> {
    const response = await next();
    if (!this.#session.started || this.#session.get(AUTH_SESSION_KEYS.id) === undefined) return response;
    if (response.headers.has('cache-control')) return response;
    // In place when the framework made the response for this request; a copy otherwise (one an app may hand out twice, or with
    // immutable headers — Response.redirect).
    const uncached = editableResponse(response);
    uncached.headers.set('cache-control', NO_STORE);
    return uncached;
  }
}
