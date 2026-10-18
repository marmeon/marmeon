import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { EncryptionConfig } from '@marmeon/encryption';
import { idOf, type Credentials } from './user.ts';

/**
 * What a session (and a remember-me token) remembers of the account: an HMAC-SHA256 of its id and its session key, under a key that
 * `APP_KEY` derives (HKDF, context `auth-session`). Whoever reads the database or a leaked store cannot make one: the account's id and
 * key are not enough. A new session key — which every new password, reset, `logoutOtherDevices()`, `updateSessionKey()` and
 * `AccountSessions` store — changes it, so every other session ends. The password hash is not part of it, so a rehash at sign-in ends
 * nothing. A fingerprint made under a key of `APP_PREVIOUS_KEYS` is still accepted.
 */
export class SessionFingerprints {
  readonly #keys: readonly Uint8Array[];

  constructor({ key, previousKeys }: Pick<EncryptionConfig, 'key' | 'previousKeys'>) {
    this.#keys = [key, ...previousKeys].map((secret) => new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), 'marmeon:auth-session', 32)));
  }

  /** The fingerprint of `credentials` under the current key. */
  of(credentials: Credentials): string {
    return this.#make(this.#keys[0]!, credentials);
  }

  /** Whether `stored` is a fingerprint of `credentials` under the current key or a previous one — compared in constant time. */
  matches(stored: unknown, credentials: Credentials): boolean {
    if (typeof stored !== 'string') return false;
    const given = Buffer.from(stored);
    let found = false;
    for (const key of this.#keys) {
      const expected = Buffer.from(this.#make(key, credentials));
      if (given.byteLength === expected.byteLength && timingSafeEqual(given, expected)) found = true;
    }
    return found;
  }

  #make(key: Uint8Array, credentials: Credentials): string {
    const parts = [String(idOf(credentials.user)), credentials.sessionKey ?? null];
    return createHmac('sha256', key).update(`marmeon-auth-session-v2:${JSON.stringify(parts)}`).digest('base64url');
  }
}
