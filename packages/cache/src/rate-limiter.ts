import { HttpError, type HttpContext, type MiddlewareClass, type Next } from '@bespokecore/router';
import { Cache } from './cache.ts';

/** How many attempts per window, and whose attempts count together (`by`). */
export class Limit {
  readonly maxAttempts: number;
  readonly decaySeconds: number;
  readonly key: string;

  constructor(maxAttempts: number, decaySeconds: number, key = '') {
    this.maxAttempts = maxAttempts;
    this.decaySeconds = decaySeconds;
    this.key = key;
  }

  static perSecond(maxAttempts: number, seconds = 1): Limit {
    return new Limit(maxAttempts, seconds);
  }
  static perMinute(maxAttempts: number, minutes = 1): Limit {
    return new Limit(maxAttempts, 60 * minutes);
  }
  static perHour(maxAttempts: number, hours = 1): Limit {
    return new Limit(maxAttempts, 3600 * hours);
  }
  static perDay(maxAttempts: number, days = 1): Limit {
    return new Limit(maxAttempts, 86_400 * days);
  }
  /** No limit — e.g. for trusted users: `user.isAdmin ? Limit.none() : Limit.perMinute(60)`. */
  static none(): Limit {
    return new Limit(Number.POSITIVE_INFINITY, 0);
  }

  /** Attempts with the same key share the limit: `by(ctx.ip)`, `by(\`${email}|${ip}\`)`. */
  by(key: string): Limit {
    return new Limit(this.maxAttempts, this.decaySeconds, key);
  }
}

export type LimiterCallback = (ctx: HttpContext) => Limit | readonly Limit[] | Promise<Limit | readonly Limit[]>;

/**
 * Counts attempts in the cache (Laravel's `RateLimiter`). Named limiters are
 * defined once — in a provider's boot — and applied with `throttle(name)`.
 */
export class RateLimiter {
  readonly #cache: Cache;
  readonly #limiters = new Map<string, LimiterCallback>();

  constructor(cache: Cache) {
    this.#cache = cache;
  }

  /** `limiter.for('login', async (ctx) => Limit.perMinute(5).by(ctx.ip ?? ''))`. */
  for(name: string, callback: LimiterCallback): this {
    this.#limiters.set(name, callback);
    return this;
  }

  limiter(name: string): LimiterCallback | undefined {
    return this.#limiters.get(name);
  }

  /** Counts one attempt against `key`; returns the attempts in the current window. */
  hit(key: string, decaySeconds: number): Promise<number> {
    return this.#cache.increment(`limiter:${key}`, 1, decaySeconds);
  }

  async attempts(key: string): Promise<number> {
    return (await this.#cache.get<number>(`limiter:${key}`)) ?? 0;
  }

  async tooManyAttempts(key: string, maxAttempts: number): Promise<boolean> {
    return (await this.attempts(key)) >= maxAttempts;
  }

  /** Seconds until `key` may try again. */
  async availableIn(key: string): Promise<number> {
    return (await this.#cache.ttl(`limiter:${key}`)) ?? 0;
  }

  clear(key: string): Promise<void> {
    return this.#cache.forget(`limiter:${key}`);
  }
}

/**
 * Middleware for a named limiter: `Route.middleware(throttle('login')).post(…)`.
 * Answers 429 with `Retry-After` once a limit is used up; successful responses
 * carry `X-RateLimit-Limit` / `X-RateLimit-Remaining`.
 */
export function throttle(name: string): MiddlewareClass<{}, {}> {
  const Throttle = class {
    readonly #limiter: RateLimiter;

    constructor(limiter: RateLimiter) {
      this.#limiter = limiter;
    }

    async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
      const callback = this.#limiter.limiter(name);
      if (!callback) throw new Error(`Rate limiter [${name}] is not defined. Define it with RateLimiter.for('${name}', …).`);
      const limits = [await callback(ctx)].flat().filter((limit) => Number.isFinite(limit.maxAttempts));

      let headers: Record<string, string> = {};
      for (const limit of limits) {
        // The window is part of the counter's key: two limits with the same `by` (per minute and per
        // second) must not share one counter — Laravel leaves that to unique `by` values.
        const key = `${name}:${limit.decaySeconds}:${limit.key}`;
        if (await this.#limiter.tooManyAttempts(key, limit.maxAttempts)) {
          const retryAfter = await this.#limiter.availableIn(key);
          throw new HttpError(429, 'Too Many Attempts.', {
            'retry-after': String(retryAfter),
            'x-ratelimit-limit': String(limit.maxAttempts),
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + retryAfter),
          });
        }
        const attempts = await this.#limiter.hit(key, limit.decaySeconds);
        headers = { 'x-ratelimit-limit': String(limit.maxAttempts), 'x-ratelimit-remaining': String(Math.max(0, limit.maxAttempts - attempts)) };
      }

      const response = await next();
      if (limits.length === 0) return response;
      const withHeaders = new Response(response.body, response);
      for (const [header, value] of Object.entries(headers)) withHeaders.headers.set(header, value);
      return withHeaders;
    }
  };
  // Readable in `route:list` and stack traces.
  Object.defineProperty(Throttle, 'name', { value: `throttle:${name}` });
  return Throttle;
}
