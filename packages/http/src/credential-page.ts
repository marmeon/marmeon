import { editableResponse, type HttpContext, type MiddlewareClass, type Next } from '@marmeon/router';

export interface CredentialPageOptions {
  /**
   * The `Referrer-Policy` of the route's answers. Default `'no-referrer'`: no request from the page carries its URL. `'same-origin'`
   * is for a page that holds no secret in its URL (the form a token route redirects to), so `back()` finds its way.
   */
  referrer?: 'no-referrer' | 'same-origin';
  /**
   * Only a request whose query has one of these parameters gets the headers; any other answer stays as the route made it (cacheable).
   * Leave it out for a route whose path is the credential. See [a public page that carries a token only sometimes](docs/security.md#a-public-page-that-carries-a-token-only-sometimes).
   */
  query?: readonly [string, ...string[]];
}

/** Answers whose `Referrer-Policy` a `credentialPage()` set, so a second one on the route can tell it from a controller's choice. */
const setByCredentialPage = new WeakSet<Response>();

/** The policy a browser applies: the last token it knows, as `isReferrerPolicy()` of `securityHeaders()` reads it. */
function lastPolicy(value: string | null): string {
  return value?.split(',').pop()?.trim().toLowerCase() ?? '';
}

/**
 * Sends the headers of a page whose URL is a credential (an invitation, a ticket, a one-time link): `Cache-Control: no-store, private`,
 * `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`, on every answer of the route: redirects, and what the route
 * itself answers with an error (binder 404, `abort()`, `signed()`, `throttle()`). A global middleware that answers first (the CSRF
 * check, a development error page) does not reach it. A `no-referrer` or `same-origin` set by a response on purpose stays; with two
 * `credentialPage()` on a route, the stricter policy wins.
 * See [a link that is a credential](docs/security.md#a-link-that-is-a-credential).
 */
export function credentialPage(options: CredentialPageOptions = {}): MiddlewareClass<{}, {}> {
  const { referrer = 'no-referrer', query } = options;
  if (query !== undefined && (!Array.isArray(query) || query.length === 0 || query.some((name) => typeof name !== 'string' || name === ''))) {
    throw new TypeError('credentialPage() expects `query` to be a non-empty list of query parameter names.');
  }
  const CredentialPage = class {
    async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
      // Parameter names are case-sensitive, as the route's own reads of the query are.
      if (query && !query.some((name) => new URL(ctx.request.url).searchParams.has(name))) return next();
      const page = editableResponse(await next());
      // Always, whatever the route said: a `public` or `max-age` from a controller would let a cache keep the token.
      page.headers.set('cache-control', 'no-store, private');
      page.headers.set('x-robots-tag', 'noindex, nofollow');
      const own = lastPolicy(page.headers.get('referrer-policy'));
      // `same-origin` from another instance gives way to this one's `no-referrer`: a URL with both tokens must not leak one in a Referer.
      const replace = own === 'same-origin' ? referrer === 'no-referrer' && setByCredentialPage.has(page) : own !== 'no-referrer';
      if (replace) {
        page.headers.set('referrer-policy', referrer);
        setByCredentialPage.add(page);
      }
      return page;
    }
  };
  Object.defineProperty(CredentialPage, 'name', { value: 'credentialPage' });
  return CredentialPage;
}
