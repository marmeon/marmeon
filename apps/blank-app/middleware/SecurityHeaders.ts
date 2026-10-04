import type { HttpContext, Next } from '@bespokecore/http';

/**
 * `Strict-Transport-Security` (E162): browsers then refuse plain HTTP for this host for `max-age` seconds — turn it on once the
 * site answers over HTTPS only (with `includeSubDomains`: every subdomain too), e.g. `'max-age=31536000; includeSubDomains'`.
 * Sent only on HTTPS responses (behind a proxy: `TRUSTED_PROXIES` and its `X-Forwarded-Proto`).
 */
const HSTS: string | false = false;

/**
 * Global middleware (see bootstrap/app.ts): every response gets these headers —
 * pages, APIs, redirects and 404s alike. The Content-Security-Policy comes from
 * `contentSecurityPolicy()` next to it (documents only, with a nonce per response).
 */
export class SecurityHeaders {
  async handle(ctx: HttpContext, next: Next<{}>) {
    const response = await next();
    // Some responses (e.g. redirects built with Response.redirect) have immutable headers.
    const secured = new Response(response.body, response);
    secured.headers.set('x-content-type-options', 'nosniff');
    secured.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    secured.headers.set('x-frame-options', 'DENY');
    if (HSTS && ctx.request.url.startsWith('https:')) secured.headers.set('strict-transport-security', HSTS);
    return secured;
  }
}
