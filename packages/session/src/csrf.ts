import { timingSafeEqual } from 'node:crypto';
import { defineConfig, type ConfigOf } from '@marmeon/core';
import { HttpError, type HttpContext, type Next } from '@marmeon/router';
import * as v from 'valibot';
import { SessionConfig } from './config.ts';
import { Session } from './session.ts';

export const CsrfConfig = defineConfig('csrf', {
  env: v.object({
    /**
     * Other origins allowed to post to this app, comma-separated (`https://admin.example.com`) — scheme, host and port, no
     * path. The app's own origin — the one a request reaches it at, and `APP_URL`'s — is always allowed.
     */
    CSRF_TRUSTED_ORIGINS: v.optional(
      v.pipe(
        v.string(),
        v.transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
        v.array(
          v.pipe(
            v.string(),
            v.url(),
            v.check((origin) => /^https?:$/.test(new URL(origin).protocol) && new URL(origin).origin === origin.replace(/\/$/, ''), 'Expected an origin like https://admin.example.com (no path)'),
          ),
        ),
      ),
      '',
    ),
    /** The app's address: its origin may always post (behind a proxy whose `X-Forwarded-*` the app does not trust, too). */
    APP_URL: v.optional(v.string()),
  }),
  resolve: (env) => ({
    /** Serialized origins (`https://admin.example.com`) — compared as the browser sends them in `Origin`. */
    trustedOrigins: env.CSRF_TRUSTED_ORIGINS.map((origin) => new URL(origin).origin),
    /** `APP_URL`'s origin, if it is a URL. */
    appOrigin: URL.parse(env.APP_URL ?? '')?.origin,
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

  /** Paths without CSRF protection; `*` matches any characters: `/webhooks/*`. */
  except(...paths: string[]): this {
    for (const path of paths) {
      const pattern = path.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      this.#except.push(new RegExp(`^${pattern}$`));
    }
    return this;
  }

  /** Turns verification off — what `@marmeon/testing` does by default, like Laravel. Never in production. */
  disable(): this {
    this.#enabled = false;
    return this;
  }

  enable(): this {
    this.#enabled = true;
    return this;
  }

  skips(path: string): boolean {
    return !this.#enabled || this.#except.some((pattern) => pattern.test(path));
  }
}

/**
 * Laravel's `VerifyCsrfToken` — with the browser's word first (decision E143, Laravel 13's model). A request that may change
 * something (not GET, HEAD, OPTIONS) passes the first of these stages that decides:
 *
 * 1. **Fetch Metadata.** `Sec-Fetch-Site: same-origin` passes — the browser says this app's own page sent it, and no page can
 *    forge the header. `same-site` and `cross-site` are refused (403) unless their `Origin` is trusted (`CSRF_TRUSTED_ORIGINS`).
 * 2. **Origin** — when the browser sends no Fetch Metadata (plain HTTP outside localhost, older browsers, other clients) or
 *    says `none` (a navigation the user started, which never posts): the app's own origin or a trusted one passes, any other
 *    is refused (403) — `null` too (a sandboxed frame, a redirect across sites).
 * 3. **The token** — neither header: the session's token must come along, as `_token` field, `X-CSRF-TOKEN` header or
 *    `X-XSRF-TOKEN` header (copied from the `XSRF-TOKEN` cookie). Without it, or without a session, 419 "Page Expired".
 *
 * So a guest needs no session to sign in (no token is handed out just for that, E143), and a client without a browser — a
 * script, a test — sends the token or its `Origin`. The app's own origin is the one the request reaches it at (scheme and host
 * from `X-Forwarded-*` of a trusted proxy, `TRUSTED_PROXIES`) and `APP_URL`'s.
 *
 * Every response of the `web` group whose session is kept (`session.persists`) refreshes the readable `XSRF-TOKEN` cookie — a
 * guest without a session gets none, and their session draws no token at all (E203: made on demand).
 */
export class VerifyCsrfToken {
  readonly #session: Session;
  readonly #protection: CsrfProtection;
  readonly #config: CsrfConfig;
  readonly #sessionConfig: SessionConfig;

  constructor(session: Session, protection: CsrfProtection, config: CsrfConfig, sessionConfig: SessionConfig) {
    this.#session = session;
    this.#protection = protection;
    this.#config = config;
    this.#sessionConfig = sessionConfig;
  }

  async handle(ctx: HttpContext, next: Next<{}>) {
    const { request } = ctx;
    if (!READING.has(request.method) && !this.#protection.skips(new URL(request.url).pathname)) {
      const from = this.#origin(request);
      if (from === 'foreign') throw new HttpError(403, 'Cross-site request refused.', {}, { key: 'marmeon.errors.cross_site' });
      if (from === 'unknown' && !(await this.#tokenMatches(ctx))) throw new HttpError(419, 'CSRF token mismatch.', {}, { key: 'marmeon.errors.csrf' });
    }
    // After the route: the token may have been rotated (login, logout).
    const response = await next();
    // A read-only request (an island, E52) sets no cookie: the page's own requests keep the browser's token current. A
    // session that is not kept (a guest's, nothing in it) has no token worth sending: it would not be valid next time.
    if (this.#session.readOnly || !this.#session.persists) return response;
    const { lifetime, secure, sameSite } = this.#sessionConfig; // lives as long as the session, like Laravel's
    // The token is made here if nothing needed it before (E203): a kept session always gets its cookie.
    ctx.cookies.set(XSRF_COOKIE, this.#session.token(), { httpOnly: false, maxAge: lifetime * 60, secure, sameSite });
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
    // Compared, not handed out (and never made here, E203): a refused request does not make a new session worth keeping, and
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
