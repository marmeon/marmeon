import { editableResponse, type HttpContext, type Next } from '@bespokecore/router';
import { Session } from '@bespokecore/session';
import { AUTH_SESSION_KEYS } from './auth.ts';

/** What a response for a signed-in user may be kept as: nowhere — not in the HTTP cache, not on a proxy. */
export const NO_STORE = 'no-store, private';

/**
 * Answers for a signed-in user are never stored (`Cache-Control: no-store, private`): pages, their JSON for
 * client-side visits, redirects and error pages. Without it, the browser keeps them in its HTTP cache, and
 * "Back" after signing out shows them again — without asking the server (and Chromium keeps `no-store`
 * pages out of the back/forward cache).
 *
 * In the `web` group of every app with @bespokecore/auth (inside the session: it asks the session, after the
 * route, whether someone is signed in — no user lookup). A route that sets its own `Cache-Control` keeps it:
 * `cacheControl('private, max-age=60')` from @bespokecore/http, or the header on its response.
 */
export class NoStoreWhenSignedIn {
  readonly #session: Session;

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
