import { editableResponse, HttpError, isLiveValidation, type HttpContext, type MiddlewareClass, type Next, type RouteDefinition } from '@marmeon/router';
import { Clock, durationToSeconds, type Duration, type Resolver } from '@marmeon/core';
import { isIP } from 'node:net';
import { Cache } from './cache.ts';

/** How many attempts per window, and whose attempts count together (`by`). */
export class Limit {
  readonly maxAttempts: number;
  readonly decaySeconds: number;
  readonly key: string;

  /** `decay` is how long a window lasts: whole seconds, or `{ minutes: 1 }` — a fraction of a second is a `RangeError`. */
  constructor(maxAttempts: number, decay: Duration, key = '') {
    const decaySeconds = durationToSeconds(decay);
    if (!Number.isInteger(decaySeconds)) throw new RangeError(`A limit's window is a whole number of seconds (the key of its counter), not ${JSON.stringify(decay)}.`);
    if (decaySeconds <= 0 && Number.isFinite(maxAttempts)) throw new RangeError(`A limit with a finite number of attempts needs a window longer than 0 seconds, not ${JSON.stringify(decay)}.`);
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

  /** Attempts with the same key share the limit: `by(clientKey(ctx.ip))`, `by(\`${email}|${clientKey(ctx.ip)}\`)`. */
  by(key: string): Limit {
    return new Limit(this.maxAttempts, this.decaySeconds, key);
  }
}

/**
 * The key that counts a client's attempts together: its IPv4 address, or for IPv6 its /64 — the block one connection gets, so
 * rotating through the addresses of it opens no new budget. An IPv4-mapped (`::ffff:203.0.113.9`) or NAT64 (`64:ff9b::/96`)
 * address counts as its IPv4 address, and a port or brackets (`203.0.113.9:443`, `[2001:db8::1]:443`) are dropped. A missing or empty
 * address is `'unknown'`; anything else that is not an address keeps a key of its own (`raw:…`) and warns once, so a proxy that sends
 * something odd does not put every client into one budget. Use it instead of `ctx.ip` in `Limit.by()`; `ctx.ip` stays the full
 * address for logs. See [rate limiting](docs/rate-limiting.md#keys-and-the-clients-address).
 */
export function clientKey(ip: string | undefined): string {
  const raw = (ip ?? '').trim();
  if (raw === '') return 'unknown';
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(raw);
  const withoutPort = bracketed ? bracketed[1]! : raw.replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/, '$1');
  const address = withoutPort.replace(/%.*$/, '');
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) {
    warnAboutUnreadableAddress();
    return `raw:${raw.slice(0, 200)}`;
  }
  const hextets = expandIPv6(address);
  const embedded = () => `${hextets[6]! >> 8}.${hextets[6]! & 0xff}.${hextets[7]! >> 8}.${hextets[7]! & 0xff}`;
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) return embedded();
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((hextet) => hextet === 0)) return embedded();
  return `${hextets.slice(0, 4).map((hextet) => hextet.toString(16)).join(':')}::/64`;
}

let warnedAboutAddress = false;

/** Once per process, at the call site of `clientKey()` (the kernel hands `ctx.ip` on as the proxy wrote it). */
function warnAboutUnreadableAddress(): void {
  if (warnedAboutAddress) return;
  warnedAboutAddress = true;
  process.emitWarning('ctx.ip is not an IP address (check what the proxy sends in X-Forwarded-For and SERVER_TRUSTED_PROXIES); rate limits count such a client by the text it sent.', 'MarmeonRateLimitWarning');
}

/** The eight 16-bit groups of a valid IPv6 address, `::` filled up and a dotted IPv4 tail turned into two groups. */
function expandIPv6(address: string): number[] {
  const [head = '', tail] = address.split('::') as [string, string | undefined];
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const read = (parts: string[]) =>
    parts.flatMap((part) => {
      if (!part.includes('.')) return [Number.parseInt(part, 16)];
      const [a, b, c, d] = part.split('.').map(Number) as [number, number, number, number];
      return [(a << 8) | b, (c << 8) | d];
    });
  const before = read(groups(head));
  const after = tail === undefined ? [] : read(groups(tail));
  return [...before, ...Array.from({ length: 8 - before.length - after.length }, () => 0), ...after];
}

/**
 * What a limiter's callback gets besides the request's context. `@marmeon/auth` adds `user`: the signed-in user when `authenticate()`
 * runs before `throttle()` on the route, else `undefined`.
 */
export interface LimiterContext {}

export type LimiterCallback = (ctx: HttpContext & LimiterContext) => Limit | readonly Limit[] | Promise<Limit | readonly Limit[]>;

/**
 * Counts attempts in the cache. Named limiters are
 * defined once — in a provider's boot — and applied with `throttle(name)`.
 *
 * Counting and deciding are ONE atomic step of the cache store (`hit` returns the new count, `attempt` decides on
 * it): 100 requests at once against a limit of 10 let exactly 10 through, across processes with a shared store
 * (`database`, `redis`; `file` on one machine). Checking first and counting afterwards would let every request
 * that checks before the others count through.
 */
export class RateLimiter {
  readonly #cache: Cache;
  readonly #limiters = new Map<string, LimiterCallback>();

  /** @internal Built by the container. */
  constructor(cache: Cache) {
    this.#cache = cache;
  }

  /** `limiter.for('login', async (ctx) => Limit.perMinute(5).by(clientKey(ctx.ip)))`. */
  for(name: string, callback: LimiterCallback): this {
    this.#limiters.set(name, callback);
    return this;
  }

  limiter(name: string): LimiterCallback | undefined {
    return this.#limiters.get(name);
  }

  /**
   * Counts one attempt against `key` and returns the attempts in the current window, this one included — atomically.
   * The first attempt opens a window of `decay`; later ones do not extend it.
   */
  hit(key: string, decay: Duration): Promise<number> {
    return this.#cache.increment(`limiter:${key}`, 1, decay);
  }

  /**
   * Counts one attempt and says whether it is within `maxAttempts` — one atomic step, so concurrent attempts can never
   * all slip through. A refused attempt counts too (the window does not restart).
   */
  async attempt(key: string, maxAttempts: number, decay: Duration): Promise<boolean> {
    return (await this.hit(key, decay)) <= maxAttempts;
  }

  async attempts(key: string): Promise<number> {
    return (await this.#cache.get<number>(`limiter:${key}`)) ?? 0;
  }

  /**
   * Whether `key` used up `maxAttempts` — a read, for showing a state. To let an attempt through, use `attempt()`:
   * checking here and counting afterwards is a race.
   */
  async tooManyAttempts(key: string, maxAttempts: number): Promise<boolean> {
    return (await this.attempts(key)) >= maxAttempts;
  }

  /** Seconds until `key` may try again. */
  async availableInSeconds(key: string): Promise<number> {
    return (await this.#cache.ttlSeconds(`limiter:${key}`)) ?? 0;
  }

  clear(key: string): Promise<void> {
    return this.#cache.forget(`limiter:${key}`);
  }
}

/**
 * Middleware for a named limiter: `Route.middleware(throttle('login')).post(…)`.
 * Answers 429 with `Retry-After` once a limit is used up; successful responses
 * carry `X-RateLimit-Limit` / `X-RateLimit-Remaining` of the tightest limit — the one with the fewest attempts left.
 * A limiter the app never defines fails the start (the server asks every route's middleware when it starts).
 */
export function throttle(name: string): MiddlewareClass<{}, {}> {
  const Throttle = class {
    /** Read by `marmeon check`: a route with this middleware has a limit. See docs/middleware.md#declaring-what-a-middleware-ensures. */
    static readonly ensures = ['rate-limited'] as const;

    /** Asked once when the server starts (the kernel's start check, an internal symbol): the limiter must be defined by then. */
    static [START_CHECK](container: Resolver, route: string): void {
      if (container.make(RateLimiter).limiter(name)) return;
      throw new Error(`Rate limiter [${name}] is not defined, but ${route} uses throttle('${name}'). Define it in a provider's boot(): app.container.make(RateLimiter).for('${name}', …).`);
    }

    readonly #limiter: RateLimiter;
    readonly #clock: Clock;

    constructor(limiter: RateLimiter, clock: Clock) {
      this.#limiter = limiter;
      this.#clock = clock;
    }

    async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
      const callback = this.#limiter.limiter(name);
      if (!callback) throw new Error(`Rate limiter [${name}] is not defined. Define it with RateLimiter.for('${name}', …).`);
      const limits = [await callback(ctx as HttpContext & LimiterContext)].flat().filter((limit) => Number.isFinite(limit.maxAttempts));
      const live = isLiveValidation(ctx.request);

      // The headers of the tightest limit: the fewest attempts left (the first of equals).
      let headers: Record<string, string> = {};
      let fewest = Number.POSITIVE_INFINITY;
      for (const limit of limits) {
        // The window is part of the counter's key: two limits with the same `by` (per minute and per
        // second) must not share one counter.
        const key = `${name}:${limit.decaySeconds}:${limit.key}`;
        // A live validation of the route is no attempt: it is held to the route's limit, but does not count against it — a
        // form checked field by field must not use up the tries of sending it (it has its own limit: `LimitLiveValidation`).
        // Every other request counts and is decided on its own count, in one atomic step (`hit`).
        const attempts = live ? await this.#limiter.attempts(key) : await this.#limiter.hit(key, limit.decaySeconds);
        if (live ? attempts >= limit.maxAttempts : attempts > limit.maxAttempts) {
          const retryAfterSeconds = await this.#limiter.availableInSeconds(key);
          throw new HttpError(
            429,
            'Too Many Attempts.',
            {
              'retry-after': String(retryAfterSeconds),
              'x-ratelimit-limit': String(limit.maxAttempts),
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.ceil(this.#clock.now() / 1000) + retryAfterSeconds),
            },
            { key: 'marmeon.errors.throttled', params: { seconds: retryAfterSeconds } },
          );
        }
        if (live) continue;
        const remaining = Math.max(0, limit.maxAttempts - attempts);
        if (remaining >= fewest) continue;
        fewest = remaining;
        headers = { 'x-ratelimit-limit': String(limit.maxAttempts), 'x-ratelimit-remaining': String(remaining) };
      }

      const response = await next();
      if (limits.length === 0 || live) return response;
      const withHeaders = editableResponse(response);
      for (const [header, value] of Object.entries(headers)) withHeaders.headers.set(header, value);
      return withHeaders;
    }
  };
  // Readable in `route:list` and stack traces.
  Object.defineProperty(Throttle, 'name', { value: `throttle:${name}` });
  return Throttle;
}

/**
 * The server's start check of route middleware — internal: the kernel calls a middleware class's method under this key once,
 * for the first route that uses it (`Symbol.for`: the same symbol in @marmeon/server, without an export). An app's own `static
 * verify` or any other name is never called.
 */
const START_CHECK = Symbol.for('marmeon.middleware.startCheck');

/** The name of the limiter for live validations — `limiter.for('live-validation', (ctx) => …)` replaces the default. */
export const LIVE_VALIDATION_LIMITER = 'live-validation';

/** The default limit of live validations: 30 a minute per client address and route. */
export const DEFAULT_LIVE_VALIDATION_LIMIT = 30;

/**
 * The limit of live validations, in the global stack: 30 a minute per route and client address, then `429`; a limiter named
 * `live-validation` replaces it. It keeps what a live validation may still tell (a `.live()` rule's "taken") from being a
 * faster way to ask than submitting. See `docs/rate-limiting.md#live-validations`.
 */
export class LimitLiveValidation {
  readonly #limiter: RateLimiter;

  /** @internal Built by the container. */
  constructor(limiter: RateLimiter) {
    this.#limiter = limiter;
  }

  async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
    // No route (an unknown path — the global stack runs for it too): nothing to validate, the 404 follows.
    const route: RouteDefinition | undefined = ctx.route;
    if (!route || !isLiveValidation(ctx.request)) return next();
    const callback = this.#limiter.limiter(LIVE_VALIDATION_LIMITER);
    const chosen = callback ? await callback(ctx) : Limit.perMinute(DEFAULT_LIVE_VALIDATION_LIMIT).by(clientKey(ctx.ip));
    const limits = [chosen].flat().filter((limit) => Number.isFinite(limit.maxAttempts));
    const name = route.routeName ?? `${ctx.request.method} ${route.path}`;
    for (const limit of limits) {
      const key = `${LIVE_VALIDATION_LIMITER}:${name}:${limit.decaySeconds}:${limit.key}`;
      if (!(await this.#limiter.attempt(key, limit.maxAttempts, limit.decaySeconds))) {
        const retryAfterSeconds = await this.#limiter.availableInSeconds(key);
        throw new HttpError(429, 'Too Many Attempts.', { 'retry-after': String(retryAfterSeconds) }, { key: 'marmeon.errors.throttled', params: { seconds: retryAfterSeconds } });
      }
    }
    return next();
  }
}
