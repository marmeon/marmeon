import { timingSafeEqual } from 'node:crypto';
import { defineConfig, type ConfigOf } from '@bespokecore/core';
import { HttpError, type HttpContext, type Next } from '@bespokecore/router';
import * as v from 'valibot';
import { SessionConfig } from './config.ts';
import { Session } from './session.ts';

export const CsrfConfig = defineConfig('csrf', {
  env: v.object({
    /**
     * Other origins allowed to post to this app, comma-separated (`https://admin.example.com`).
     * The app's own host is always allowed.
     */
    CSRF_TRUSTED_ORIGINS: v.optional(
      v.pipe(
        v.string(),
        v.transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
        v.array(v.pipe(v.string(), v.url())),
      ),
      '',
    ),
  }),
  resolve: (env) => ({ trustedOrigins: env.CSRF_TRUSTED_ORIGINS.map((origin) => new URL(origin).host) }),
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

  /** Turns verification off — what `@bespokecore/testing` does by default, like Laravel. Never in production. */
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
 * Laravel's `VerifyCsrfToken`, plus a second line of defence (decision E15):
 *
 * 1. Browsers that say a request is cross-site (`Sec-Fetch-Site`) or come from a
 *    foreign `Origin` are refused outright.
 * 2. Every non-reading request must carry the session's token — as `_token` field,
 *    `X-CSRF-TOKEN` header or `X-XSRF-TOKEN` header (copied from the `XSRF-TOKEN` cookie).
 *
 * Failures answer 419 "Page Expired". Every response of the `web` group refreshes
 * the readable `XSRF-TOKEN` cookie.
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
    const path = new URL(ctx.request.url).pathname;
    if (!READING.has(ctx.request.method) && !this.#protection.skips(path)) {
      if (this.#crossSite(ctx.request) || !(await this.#tokenMatches(ctx))) {
        throw new HttpError(419, 'CSRF token mismatch.');
      }
    }
    // After the route: the token may have been rotated (login, logout).
    const response = await next();
    const { lifetime, secure, sameSite } = this.#sessionConfig; // lives as long as the session, like Laravel's
    ctx.cookies.set(XSRF_COOKIE, this.#session.token(), { httpOnly: false, maxAge: lifetime * 60, secure, sameSite });
    return response;
  }

  #crossSite(request: Request): boolean {
    if (request.headers.get('sec-fetch-site') === 'cross-site') return true;
    const origin = request.headers.get('origin');
    if (!origin) return false; // old clients, curl: the token alone decides
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return true; // "null" (sandboxed frames, some redirects) or garbage
    }
    return host !== new URL(request.url).host && !this.#config.trustedOrigins.includes(host);
  }

  async #tokenMatches(ctx: HttpContext): Promise<boolean> {
    const header = ctx.request.headers.get('x-csrf-token') ?? ctx.request.headers.get('x-xsrf-token');
    const field = header ?? (await ctx.input())._token;
    return typeof field === 'string' && constantTimeEquals(field, this.#session.token());
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
