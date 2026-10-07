import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Clock } from '@marmeon/core';
import { EncryptionConfig } from '@marmeon/encryption';
import { fillPath, HttpError, Router, toSearchParams, type CheckRouteName, type HttpContext, type Next, type Param, type ParamsOf, type RouteNameInput } from '@marmeon/router';

/** The route's path parameters, plus any others — those are signed into the query. */
export type SignedParams<N extends string> = ParamsOf<N> & Readonly<Record<string, Param>>;

type SignedArgs<N extends string> = {} extends ParamsOf<N>
  ? [params?: SignedParams<N>, options?: SignedRouteOptions]
  : [params: SignedParams<N>, options?: SignedRouteOptions];

/** `3600` seconds, or `'60m'`, `'2h'`, `'7d'`, `'30s'`. */
export type Duration = number | `${number}${'s' | 'm' | 'h' | 'd'}`;

export interface SignedRouteOptions {
  /** Prepended to the path: `https://app.example` → an absolute link, e.g. for a mail. */
  readonly base?: string;
}

/** A signed path (not a named route): its query, its expiry, its base. */
export interface SignedPathOptions extends SignedRouteOptions {
  /** Signed with the path (`signature` and `expires` are reserved). */
  readonly query?: Readonly<Record<string, string>>;
  /** Stops working after this; without it the link never expires. */
  readonly expiresIn?: Duration;
}

const UNIT = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

function seconds(duration: Duration): number {
  if (typeof duration === 'number') return duration;
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new TypeError(`Invalid duration "${duration}" — use seconds or e.g. '60m'.`);
  return Number(match[1]) * UNIT[match[2] as keyof typeof UNIT];
}

/** A key for one purpose, derived from `APP_KEY` (HKDF): a signature is never also a cookie or session key. */
function derive(key: Uint8Array, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, new Uint8Array(0), `marmeon:${purpose}`, 32));
}

/**
 * Signed URLs (Laravel's `URL::signedRoute`): links that prove the app made them — for e-mail
 * verification, one-click unsubscribe, downloads. HMAC-SHA-256 over the path and the sorted query,
 * with a key of its own derived from `APP_KEY` (and from `APP_PREVIOUS_KEYS`, so links survive a key
 * rotation). Protect the route with `signed()`.
 *
 * ```ts
 * const url = signer.temporarySignedRoute('auth.verification.verify', { id: user.id, hash }, '60m', { base: config.url });
 * ```
 *
 * The host is not signed: a link is valid on every host of the app (behind proxies, the request
 * host is not always the public one).
 */
export class UrlSigner {
  readonly #router: Router;
  readonly #keys: readonly Buffer[];
  readonly #clock: Clock;

  constructor(router: Router, config: EncryptionConfig, clock: Clock) {
    this.#router = router;
    this.#keys = [config.key, ...config.previousKeys].map((key) => derive(key, 'signed-url'));
    this.#clock = clock;
  }

  /**
   * A signed link to a named route that never expires. Parameters the path does not take go into the query —
   * and are signed with it (`{ id, hash, list: 'news' }`).
   */
  signedRoute<const N extends RouteNameInput>(name: CheckRouteName<N>, ...[params, options = {}]: SignedArgs<N>): string {
    return this.#sign(this.#route(name, params ?? {}), undefined, options);
  }

  /** A signed link that stops working after `expiresIn`. */
  temporarySignedRoute<const N extends RouteNameInput>(
    name: CheckRouteName<N>,
    params: SignedParams<N>,
    expiresIn: Duration,
    options: SignedRouteOptions = {},
  ): string {
    return this.#sign(this.#route(name, params), this.#expiry(expiresIn), options);
  }

  /**
   * A signed link to a path the app serves without a route name — e.g. a file of a disk
   * (`/_marmeon/storage/local/exports/7.json`). `path` is used as given: percent-encode its segments.
   */
  signedPath(path: string, options: SignedPathOptions = {}): string {
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) throw new Error(`signedPath() takes a path without query or fragment, not "${path}".`);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (key === 'signature' || key === 'expires') throw new Error(`"${key}" is reserved in signed URLs.`);
      query.set(key, value);
    }
    return this.#sign({ path, query }, options.expiresIn === undefined ? undefined : this.#expiry(options.expiresIn), options);
  }

  /** Whether `url` (absolute, or path and query) carries a valid, unexpired signature. */
  hasValidSignature(url: string | URL): boolean {
    const parsed = new URL(url, 'http://signed.invalid');
    const signature = parsed.searchParams.get('signature');
    if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
    const expires = parsed.searchParams.get('expires');
    if (expires !== null && (!/^\d{1,12}$/.test(expires) || Number(expires) <= Math.floor(this.#clock.now() / 1000))) return false;
    const payload = canonical(parsed.pathname, parsed.searchParams);
    const given = Buffer.from(signature, 'hex');
    // Every key is tried, the comparison is constant-time: the time does not tell which key nearly matched.
    let valid = false;
    for (const key of this.#keys) valid = timingSafeEqual(createHmac('sha256', key).update(payload).digest(), given) || valid;
    return valid;
  }

  /** Seconds since the epoch, by the app's clock (E97). */
  #expiry(expiresIn: Duration): number {
    return Math.floor(this.#clock.now() / 1000) + seconds(expiresIn);
  }

  #route(name: string, params: Readonly<Record<string, Param>>): { path: string; query: URLSearchParams } {
    const route = this.#router.findByName(name);
    if (!route) throw new Error(`Route [${name}] is not defined.`);
    for (const key of ['signature', 'expires']) if (key in params) throw new Error(`"${key}" is reserved in signed URLs.`);
    // The same code path as `Router.url()`: path parameters into the path, the rest into the query.
    const { path, rest } = fillPath(name, route.path, params);
    return { path, query: toSearchParams(rest) };
  }

  #sign({ path, query }: { path: string; query: URLSearchParams }, expires: number | undefined, { base }: SignedRouteOptions): string {
    if (expires !== undefined) query.set('expires', String(expires));
    const signature = createHmac('sha256', this.#keys[0]!).update(canonical(path, query)).digest('hex');
    query.set('signature', signature);
    const relative = `${path}?${query.toString()}`;
    return base === undefined ? relative : new URL(relative, base).href;
  }
}

/** Path plus the query without `signature`, sorted — the order of parameters changes nothing. */
function canonical(path: string, query: URLSearchParams): string {
  const pairs = [...query].filter(([key]) => key !== 'signature').sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  return `${path}?${new URLSearchParams(pairs).toString()}`;
}

/** Only for signed links (Laravel's `signed` middleware): a missing, wrong or expired signature answers 403. */
export class ValidateSignature {
  readonly #signer: UrlSigner;

  constructor(signer: UrlSigner) {
    this.#signer = signer;
  }

  handle(ctx: HttpContext, next: Next<{}>) {
    if (!this.#signer.hasValidSignature(ctx.request.url)) throw new HttpError(403, 'Invalid signature.', {}, { key: 'marmeon.errors.signature' });
    return next();
  }
}

/** `Route.middleware(signed()).get('/email/verify/:id/:hash', …)` */
export function signed(): typeof ValidateSignature {
  return ValidateSignature;
}
