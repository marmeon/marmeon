import { editableResponse, type HttpContext, type MiddlewareClass, type Next } from '@marmeon/router';

export interface CredentialPageOptions {
  /**
   * The `Referrer-Policy` of the route's answers. Default `'no-referrer'`: no request from the page carries its URL. `'same-origin'`
   * is for a page that holds no secret in its URL (the form a token route redirects to), so `back()` finds its way.
   */
  referrer?: 'no-referrer' | 'same-origin';
}

/** The policy a browser applies: the last token it knows, as `isReferrerPolicy()` of `securityHeaders()` reads it. */
function lastPolicy(value: string | null): string {
  return value?.split(',').pop()?.trim().toLowerCase() ?? '';
}

/**
 * Sends the headers of a page whose URL is a credential (an invitation, a ticket, a one-time link): `Cache-Control: no-store, private`,
 * `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`, on every answer of the route: redirects, and what the route
 * itself answers with an error (binder 404, `abort()`, `signed()`, `throttle()`). A global middleware that answers first (the CSRF
 * check, a development error page) does not reach it. A `no-referrer` or `same-origin` set by a response on purpose stays.
 * See [a link that is a credential](docs/security.md#a-link-that-is-a-credential).
 */
export function credentialPage(options: CredentialPageOptions = {}): MiddlewareClass<{}, {}> {
  const { referrer = 'no-referrer' } = options;
  const CredentialPage = class {
    async handle(_ctx: HttpContext, next: Next<{}>): Promise<Response> {
      const page = editableResponse(await next());
      // Always, whatever the route said: a `public` or `max-age` from a controller would let a cache keep the token.
      page.headers.set('cache-control', 'no-store, private');
      page.headers.set('x-robots-tag', 'noindex, nofollow');
      const own = lastPolicy(page.headers.get('referrer-policy'));
      if (own !== 'no-referrer' && own !== 'same-origin') page.headers.set('referrer-policy', referrer);
      return page;
    }
  };
  Object.defineProperty(CredentialPage, 'name', { value: 'credentialPage' });
  return CredentialPage;
}
