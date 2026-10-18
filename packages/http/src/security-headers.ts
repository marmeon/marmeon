import { editableResponse, type HttpContext, type MiddlewareClass, type Next } from '@marmeon/router';

const REFERRER_POLICIES = [
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
] as const;

/** The values `Referrer-Policy` takes. */
export type ReferrerPolicy =
  | 'no-referrer'
  | 'no-referrer-when-downgrade'
  | 'origin'
  | 'origin-when-cross-origin'
  | 'same-origin'
  | 'strict-origin'
  | 'strict-origin-when-cross-origin'
  | 'unsafe-url';

export interface HstsOptions {
  /** Seconds browsers refuse plain HTTP for this host: a whole number; 0 withdraws HSTS from the browsers that have seen it. */
  maxAge: number;
  /** Every subdomain too. */
  includeSubDomains?: boolean;
  /** Ask for the browsers' preload lists: needs `includeSubDomains` and a `maxAge` of at least a year. */
  preload?: boolean;
}

export interface SecurityHeadersOptions {
  /**
   * `Strict-Transport-Security`, sent on HTTPS responses only (behind a proxy: `TRUSTED_PROXIES` and its `X-Forwarded-Proto`).
   * Off by default: turn it on once the site answers over HTTPS only — browsers hold on to it for `maxAge` seconds.
   */
  hsts?: false | HstsOptions;
  /** `X-Frame-Options` for responses without a valid one of their own; `false` sends none. Default `'DENY'`. */
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  /** `Referrer-Policy` for responses without a valid one of their own; `false` sends none. Default `'strict-origin-when-cross-origin'`. */
  referrerPolicy?: ReferrerPolicy | false;
}

const YEAR = 31_536_000;

/** A framing policy a browser enforces: anything else (`ALLOW-FROM`, `ALLOWALL`, empty) is ignored by browsers, so it protects nothing. */
const FRAME_OPTIONS = /^\s*(?:DENY|SAMEORIGIN)\s*$/i;

/** Every comma-separated token is a known policy (browsers use the last one they know, so one unknown token must not pass). */
function isReferrerPolicy(value: string): boolean {
  const tokens = value.split(',').map((token) => token.trim().toLowerCase());
  return tokens.every((token) => (REFERRER_POLICIES as readonly string[]).includes(token));
}

function compileHsts(hsts: HstsOptions): string {
  const { maxAge, includeSubDomains = false, preload = false } = hsts;
  if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
    throw new TypeError(`securityHeaders(): hsts.maxAge must be a whole number of seconds (0 withdraws HSTS), got ${String(maxAge)}.`);
  }
  if (preload && (!includeSubDomains || maxAge < YEAR)) {
    throw new TypeError(`securityHeaders(): hsts.preload needs includeSubDomains and a maxAge of at least ${YEAR} (one year).`);
  }
  return `max-age=${maxAge}${includeSubDomains ? '; includeSubDomains' : ''}${preload ? '; preload' : ''}`;
}

/**
 * Global middleware: every response — pages, APIs, redirects and 404s — gets `X-Content-Type-Options: nosniff`, a
 * `Referrer-Policy` and an `X-Frame-Options`, and with `hsts` a `Strict-Transport-Security` on HTTPS. A route's own valid
 * `X-Frame-Options` and `Referrer-Policy` stay (a page made for embedding says `SAMEORIGIN`); `nosniff` and HSTS always follow the
 * configuration, so no route weakens them. The `Content-Security-Policy` is `contentSecurityPolicy()`'s. See docs/csp.md#the-other-security-headers.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): MiddlewareClass<{}, {}> {
  const { hsts = false, frameOptions = 'DENY', referrerPolicy = 'strict-origin-when-cross-origin' } = options;
  const hstsValue = hsts === false ? false : compileHsts(hsts);

  const SecurityHeaders = class {
    async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
      // In place when the framework made the response for this request; a copy otherwise (one an app may hand out twice, or
      // whose headers are immutable — Response.redirect).
      const secured = editableResponse(await next());
      const headers = secured.headers;
      headers.set('x-content-type-options', 'nosniff');
      // A route's own value stays when it is a valid one; an invalid one (passed through from an upstream answer, say) protects nothing.
      if (referrerPolicy && !isReferrerPolicy(headers.get('referrer-policy') ?? '')) headers.set('referrer-policy', referrerPolicy);
      if (frameOptions && !FRAME_OPTIONS.test(headers.get('x-frame-options') ?? '')) headers.set('x-frame-options', frameOptions);
      if (hstsValue && ctx.request.url.startsWith('https:')) headers.set('strict-transport-security', hstsValue);
      return secured;
    }
  };
  Object.defineProperty(SecurityHeaders, 'name', { value: 'SecurityHeaders' });
  return SecurityHeaders;
}
