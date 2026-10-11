import { editableResponse, type HttpContext, type Next } from '@marmeon/http';

/**
 * Global middleware (see DocsServiceProvider): every answer — pages, assets' 404s, the search — is never sniffed into another
 * type, sends no full URL to other sites and is never framed. HSTS comes from the proxy in front (deploy/website/Caddyfile), the
 * Content-Security-Policy from `contentSecurityPolicy()` next to it. The values are the same for everybody: cacheable.
 */
export class SecurityHeaders {
  async handle(_ctx: HttpContext, next: Next<{}>) {
    const secured = editableResponse(await next());
    secured.headers.set('x-content-type-options', 'nosniff');
    secured.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    secured.headers.set('x-frame-options', 'DENY');
    return secured;
  }
}
