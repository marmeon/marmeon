import type { HttpContext, Next } from '@bespokecore/http';

/**
 * Global middleware (see bootstrap/app.ts): every response gets these headers —
 * pages, APIs, redirects and 404s alike.
 */
export class SecurityHeaders {
  async handle(_ctx: HttpContext, next: Next<{}>) {
    const response = await next();
    // Some responses (e.g. redirects built with Response.redirect) have immutable headers.
    const secured = new Response(response.body, response);
    secured.headers.set('x-content-type-options', 'nosniff');
    secured.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    secured.headers.set('x-frame-options', 'DENY');
    return secured;
  }
}
