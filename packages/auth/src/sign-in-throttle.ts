import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { clientKey, type RateLimiter } from '@marmeon/cache';
import type { Clock, Logger } from '@marmeon/core';
import type { EncryptionConfig } from '@marmeon/encryption';
import type { SessionConfig } from '@marmeon/session';
import type { AuthConfig } from './config.ts';
import { idOf, type Credentials } from './user.ts';

const CLIENT_SECONDS = 60;
const ACCOUNT_SECONDS = 86_400;
/** What one device cookie may attempt outside the account's shared ceiling: ten password sign-ins an hour. */
const DEVICE_ATTEMPTS = 10;
const DEVICE_SECONDS = 3600;
/** How far ahead of this server's clock a device cookie's date may be (another node's clock). */
const CLOCK_SKEW_SECONDS = 300;

/** An account past its daily ceiling: the seconds to wait, and whether this is the first refusal of the window (the owner is told once). */
export interface AccountHeld {
  readonly retryAfter: number;
  readonly first: boolean;
}

/** The device cookie to set: the package decides its name, value and attributes, the controller only sets it (`ctx.cookies.set(name, value, options)`). */
export interface DeviceCookie {
  readonly name: string;
  readonly value: string;
  readonly options: { readonly httpOnly: true; readonly secure: boolean; readonly sameSite: SessionConfig['sameSite']; readonly path: '/'; readonly maxAge: number };
}

/**
 * The limits of password sign-ins that `Auth.attempt()` applies itself: per client and identifier a minute, per account a day, and the
 * device cookie that lets the owner's browser past the account's shared ceiling. Every key is an HMAC under a key that `APP_KEY`
 * derives (HKDF, context `marmeon:auth-login-throttle`) or an account's id: a cache key, and so a cache dump, holds no address, no
 * client address and nothing a word list could be checked against. The counters are short-lived, so a key of `APP_PREVIOUS_KEYS` is not
 * tried for them. See `docs/authentication.md#limits-on-password-sign-ins`.
 */
export class SignInThrottle {
  readonly #limiter: RateLimiter;
  readonly #key: Uint8Array;
  readonly #deviceKeys: readonly Uint8Array[];
  readonly #perMinute: number;
  readonly #perDay: number;
  readonly #deviceDays: number;
  readonly #session: Pick<SessionConfig, 'secure' | 'sameSite'>;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(
    limiter: RateLimiter,
    { key, previousKeys }: Pick<EncryptionConfig, 'key' | 'previousKeys'>,
    config: Pick<AuthConfig, 'loginAttemptsPerMinute' | 'accountSignInsPerDay' | 'deviceCookieDays'>,
    session: Pick<SessionConfig, 'secure' | 'sameSite'>,
    clock: Clock,
    logger: Logger,
  ) {
    this.#limiter = limiter;
    // A domain separator of stored counter keys, not a name: changing it resets every count at deploy.
    this.#key = derive(key, 'marmeon:auth-login-throttle');
    // A device cookie lives for months, so it is also accepted under the keys of APP_PREVIOUS_KEYS.
    this.#deviceKeys = [key, ...previousKeys].map((secret) => derive(secret, 'marmeon:auth-device'));
    this.#perMinute = config.loginAttemptsPerMinute;
    this.#perDay = config.accountSignInsPerDay;
    this.#deviceDays = config.deviceCookieDays;
    this.#session = session;
    this.#clock = clock;
    this.#logger = logger;
  }

  /**
   * Counts one password sign-in of `identifier` from this client (an IPv6 address counts as its /64) and returns the wait in seconds
   * when the minute is used up. Counted BEFORE the password is checked, in one atomic step: guesses sent at once can never all get
   * past the limit (checking first and counting after a failure lets every request that checks before the others through).
   */
  async takeClient(identifier: string, ip: string | undefined): Promise<number | undefined> {
    const key = this.#clientKey(identifier, ip);
    if (await this.#limiter.attempt(key, this.#perMinute, CLIENT_SECONDS)) return undefined;
    return Math.max(1, await this.#limiter.availableIn(key));
  }

  /**
   * Counts one password sign-in against the account, however many clients they come from, before the password is checked. The account's
   * id keys the count when there is one, else the identifier does, so a known and an unknown account do the same work. Past the
   * ceiling nothing is checked: the right password included. The owner gets in with a password reset or a passkey.
   */
  async takeAccount(identifier: string, userId: string | number | undefined): Promise<AccountHeld | undefined> {
    const key = this.#accountKey(identifier, userId);
    if (await this.#limiter.attempt(key, this.#perDay, ACCOUNT_SECONDS)) return undefined;
    // Once per window: the owner is told, the app can listen for the event.
    const first = await this.#limiter.attempt(`${key}|notice`, 1, ACCOUNT_SECONDS);
    return { retryAfter: Math.max(1, await this.#limiter.availableIn(key)), first };
  }

  /**
   * Counts one password sign-in of a browser with a valid device cookie, on a limit of its own; `false` once the hour is used up, and
   * then the cookie counts for nothing until the hour is over: the attempt goes against the account's shared ceiling like any other.
   */
  async takeDevice(nonce: string): Promise<boolean> {
    return this.#limiter.attempt(`login-device:${this.#digest(`device:${nonce}`)}`, DEVICE_ATTEMPTS, DEVICE_SECONDS);
  }

  /** The owner is in (a password, a passkey, a second factor): this client's minute starts over. Best effort, see {@link clearAccount}. */
  async clearClient(identifier: string, ip: string | undefined): Promise<void> {
    await this.#clear([this.#clientKey(identifier, ip)]);
  }

  /**
   * The owner is in or has a new password: the account's count and notice start over. Best effort: a cache that fails here leaves the
   * count where it is — the safe side — and must not undo a sign-in or a reset that already stands.
   */
  async clearAccount(userId: string | number): Promise<void> {
    const key = this.#accountKey('', userId);
    await this.#clear([key, `${key}|notice`]);
  }

  /** The name of the device cookie: `__Host-` over HTTPS, like the remember-me cookie. */
  get deviceCookieName(): string {
    return this.#session.secure ? '__Host-marmeon_device' : 'marmeon_device';
  }

  /**
   * A device cookie for the browser of `credentials`' owner, who just proved the password (a sign-in, a completed reset): signed under a
   * key from `APP_KEY` and bound to the account's id and its current session key, so a new password, `AccountSessions.end()` and
   * `endEveryone()` (each writes a new key) make every earlier one worthless. `undefined` when `AUTH_DEVICE_COOKIE_DAYS` is `0`.
   */
  issueDevice(credentials: Credentials): DeviceCookie | undefined {
    if (this.#deviceDays === 0) return undefined;
    const issued = Math.floor(this.#clock.now() / 1000);
    const payload = Buffer.from(JSON.stringify([String(idOf(credentials.user)), randomBytes(16).toString('base64url'), issued])).toString('base64url');
    const value = `${payload}.${this.#sign(this.#deviceKeys[0]!, payload, credentials)}`;
    return { name: this.deviceCookieName, value, options: { httpOnly: true, secure: this.#session.secure, sameSite: this.#session.sameSite, path: '/', maxAge: this.#deviceDays * 86_400 } };
  }

  /**
   * The nonce of the device cookie when `value` is a valid, unexpired one for exactly this account (its id and current session key), else
   * `undefined` — for a forged, expired, foreign or stale cookie and for none alike, so nothing tells which it was.
   */
  deviceNonce(value: unknown, credentials: Credentials): string | undefined {
    if (this.#deviceDays === 0 || typeof value !== 'string') return undefined;
    const [payload, mac, ...rest] = value.split('.');
    if (payload === undefined || mac === undefined || rest.length > 0) return undefined;
    const given = Buffer.from(mac);
    let genuine = false;
    for (const key of this.#deviceKeys) {
      const expected = Buffer.from(this.#sign(key, payload, credentials));
      if (given.byteLength === expected.byteLength && timingSafeEqual(given, expected)) genuine = true;
    }
    if (!genuine) return undefined;
    try {
      const [id, nonce, issued] = JSON.parse(Buffer.from(payload, 'base64url').toString()) as [unknown, unknown, unknown];
      if (id !== String(idOf(credentials.user)) || typeof nonce !== 'string' || typeof issued !== 'number') return undefined;
      const now = this.#clock.now() / 1000;
      if (issued > now + CLOCK_SKEW_SECONDS || issued + this.#deviceDays * 86_400 <= now) return undefined;
      return nonce;
    } catch {
      return undefined;
    }
  }

  #sign(key: Uint8Array, payload: string, credentials: Credentials): string {
    return createHmac('sha256', key).update(`marmeon-auth-device-v1:${JSON.stringify([payload, credentials.sessionKey ?? null])}`).digest('base64url');
  }

  async #clear(keys: readonly string[]): Promise<void> {
    try {
      for (const key of keys) await this.#limiter.clear(key);
    } catch (error) {
      this.#logger.error('The count of password sign-ins could not be cleared; it stays where it is.', { error: String(error) });
    }
  }

  // The client's address is hashed too: a dump of the cache is no list of the addresses that tried an account.
  #clientKey(identifier: string, ip: string | undefined): string {
    return `login:${this.#digest(identifier)}|${this.#digest(`ip:${clientKey(ip)}`)}`;
  }

  #accountKey(identifier: string, userId: string | number | undefined): string {
    return userId === undefined ? `login-account:identifier:${this.#digest(identifier)}` : `login-account:id:${String(userId)}`;
  }

  // Trimmed and lower-cased, as the sign-in form normalizes it: spellings of one address share their counters.
  #digest(value: string): string {
    return createHmac('sha256', this.#key).update(`marmeon-auth-login-v1:${value.trim().toLowerCase()}`).digest('base64url');
  }
}

function derive(secret: Uint8Array, label: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), label, 32));
}
