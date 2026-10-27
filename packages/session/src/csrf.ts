import { timingSafeEqual } from 'node:crypto';
import { defineConfig, env, type ConfigOf } from '@marmeon/core';
import { isWebhookMiddleware } from '@marmeon/http/internal';
import { HttpError, type HttpContext, type Next } from '@marmeon/router';
import { SessionConfig } from './config.ts';
import { Session } from './session.ts';

const ORIGIN = 'Expected an origin like https://admin.example.com (no path)';

/**
 * Which origins may post besides the app's own (`CSRF_TRUSTED_ORIGINS`, `APP_URL`). The check itself cannot be switched off from
 * configuration. See `docs/csrf.md#trusting-other-origins`.
 */
export const CsrfConfig = defineConfig('csrf', {
  env: env({
    /**
     * Other origins allowed to post to this app, comma-separated (`https://admin.example.com`) — scheme, host and port, no
     * path. The app's own origin — the one a request reaches it at, and `APP_URL`'s — is always allowed.
     */
    CSRF_TRUSTED_ORIGINS: env.list(env.url({ message: ORIGIN }).check((origin) => new URL(origin).origin === origin.replace(/\/$/, ''), ORIGIN)).default([]),
    /** The app's address: its origin may always post (behind a proxy whose `X-Forwarded-*` the app does not trust, too). */
    APP_URL: env.string().optional(),
  }),
  resolve: (e) => ({
    /** Serialized origins (`https://admin.example.com`) — compared as the browser sends them in `Origin`. */
    trustedOrigins: e.CSRF_TRUSTED_ORIGINS.map((origin) => new URL(origin).origin),
    /** `APP_URL`'s origin, if it is a URL. */
    appOrigin: URL.parse(e.APP_URL ?? '')?.origin,
  }),
});
export type CsrfConfig = ConfigOf<typeof CsrfConfig>;

/** The cookie the browser's JavaScript reads to send the token back as `X-XSRF-TOKEN`. */
export const XSRF_COOKIE = 'XSRF-TOKEN';

const READING = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * What CSRF protection skips: paths (webhooks) and — in tests — everything.
 * A singleton; modules add paths through `csrfExcept`.
 */
export class CsrfProtection {
  #enabled = true;
  readonly #except: RegExp[] = [];
  readonly #protected: boolean;

  /** @internal Built by the container; `protected` is the app's environment (`SessionConfig.protected`). */
  constructor(isProtected = true) {
    this.#protected = isProtected;
  }

  /**
   * Paths without CSRF protection; `*` matches any characters: `/webhooks/*`. A pattern that matches every path (`*`, `/*`) throws:
   * a route that needs no verification belongs in a group without `VerifyCsrfToken`.
   */
  except(...paths: string[]): this {
    for (const path of paths) {
      const pattern = path.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      const regexp = new RegExp(`^${pattern}$`);
      if (regexp.test('/') && regexp.test('/a/b/c')) {
        throw new TypeError(`CSRF exclusion '${path}' matches every path, which turns the protection off. Name the paths that need it, or put such routes in a group without CSRF verification.`);
      }
      this.#except.push(regexp);
    }
    return this;
  }

  /**
   * Turns verification off — what `createTestApp()` does by itself (`createTestApp(app, { csrf: true })` keeps it on). Throws
   * in a protected environment (production, or any `NODE_ENV` but development and test): a stray call would leave it without CSRF protection.
   * @internal
   */
  disable(): this {
    if (this.#protected) {
      throw new Error('CsrfProtection.disable() runs only in development and tests — a test app turns CSRF protection off by itself (createTestApp(app, { csrf: true }) keeps it on).');
    }
    this.#enabled = false;
    return this;
  }

  /** @internal Turns verification on again after {@link CsrfProtection.disable}. */
  enable(): this {
    this.#enabled = true;
    return this;
  }

  /** @internal What `VerifyCsrfToken` asks: whether `path` is excepted, or verification is off. */
  skips(path: string): boolean {
    return !this.#enabled || this.#except.some((pattern) => pattern.test(path));
  }
}

/**
 * CSRF protection with the browser's word first: a request that may change something (not GET, HEAD, OPTIONS) passes the first
 * stage that decides — **Fetch Metadata** (`same-origin` passes; `same-site`/`cross-site` are a 403 unless their `Origin` is
 * trusted), then the **Origin** (the app's own or a trusted one; any other, `null` too, is a 403), then **the session's token**
 * (`_token`, `X-CSRF-TOKEN` or `X-XSRF-TOKEN`; without it, or without a session, 419). A kept session's responses refresh the
 * readable `XSRF-TOKEN` cookie. See `docs/csrf.md#how-a-request-is-checked`.
 */
export class VerifyCsrfToken {
  readonly #session: Session;
  readonly #protection: CsrfProtection;
  readonly #config: CsrfConfig;
  readonly #sessionConfig: SessionConfig;

  /** @internal Built by the container. */
  constructor(session: Session, protection: CsrfProtection, config: CsrfConfig, sessionConfig: SessionConfig) {
    this.#session = session;
    this.#protection = protection;
    this.#config = config;
    this.#sessionConfig = sessionConfig;
  }

  async handle(ctx: HttpContext, next: Next<{}>) {
    const { request } = ctx;
    // A route behind `verifyWebhook()` is signed by its sender, who has no session: the signature is its protection, and only a route
    // that names the middleware skips the check.
    const signed = ctx.route?.middleware.some(isWebhookMiddleware) === true;
    if (!signed && !READING.has(request.method) && !this.#protection.skips(new URL(request.url).pathname)) {
      const from = this.#origin(request);
      if (from === 'foreign') throw new HttpError(403, 'Cross-site request refused.', {}, { key: 'marmeon.errors.cross_site' });
      if (from === 'unknown' && !(await this.#tokenMatches(ctx))) throw new HttpError(419, 'CSRF token mismatch.', {}, { key: 'marmeon.errors.csrf' });
    }
    // After the route: the token may have been rotated (login, logout).
    const response = await next();
    // A read-only request (an island) sets no cookie: the page's own requests keep the browser's token current. A
    // session that is not kept (a guest's, nothing in it) has no token worth sending: it would not be valid next time.
    if (this.#session.readOnly || !this.#session.persists) return response;
    const { secure, sameSite } = this.#sessionConfig; // no Max-Age: it ends with the browser, like the session cookie
    // The token is made here if nothing needed it before: a kept session always gets its cookie.
    // Sent when it differs from the browser's: a cookie on every response would let a shared cache that stores one hand the token to a stranger.
    const token = this.#session.token();
    if (ctx.cookies.get(XSRF_COOKIE) !== token) ctx.cookies.set(XSRF_COOKIE, token, { httpOnly: false, secure, sameSite });
    return response;
  }

  /** Where the browser says the request comes from: this app (or an origin it trusts), elsewhere, or it does not say. */
  #origin(request: Request): 'own' | 'foreign' | 'unknown' {
    const site = request.headers.get('sec-fetch-site');
    if (site === 'same-origin') return 'own';
    const origin = request.headers.get('origin');
    if (site === 'same-site' || site === 'cross-site') return origin !== null && this.#trusted(origin, request) ? 'own' : 'foreign';
    // No Fetch Metadata (or `none`, or a value this code does not know): the Origin decides — and without one, the token.
    if (origin === null) return 'unknown';
    return this.#trusted(origin, request) ? 'own' : 'foreign';
  }

  /** The app's own origin — as reached, or `APP_URL`'s — or a trusted one. `null` is no origin at all: never trusted. */
  #trusted(origin: string, request: Request): boolean {
    if (origin === 'null') return false;
    return origin === this.#config.appOrigin || this.#config.trustedOrigins.includes(origin) || origin === new URL(request.url).origin;
  }

  async #tokenMatches(ctx: HttpContext): Promise<boolean> {
    const header = ctx.request.headers.get('x-csrf-token') ?? ctx.request.headers.get('x-xsrf-token');
    const field = header ?? (await ctx.input())._token;
    // Compared, not handed out (and never made here): a refused request does not make a new session worth keeping, and
    // a session without a token matches nothing.
    const token = this.#session.currentToken();
    return typeof field === 'string' && token !== undefined && constantTimeEquals(field, token);
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
