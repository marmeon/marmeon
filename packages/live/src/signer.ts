import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { LiveSigner } from '@marmeon/http';

/** The keys of live tokens: from `APP_KEY` (and the previous keys, still accepted) by HKDF, context `live`. */
export function liveKeys(key: Uint8Array, previousKeys: readonly Uint8Array[] = []): readonly Uint8Array[] {
  return [key, ...previousKeys].map((secret) => new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), 'marmeon:live', 32)));
}

/** Account scopes start with this (a session scope never holds a colon): the hub tells the two apart without a field on the message. */
export const ACCOUNT_PREFIX = 'a:';
const accountDigest = (key: Uint8Array, unkeyed: string) => ACCOUNT_PREFIX + createHmac('sha256', key).update(`marmeon:live-account\n${unkeyed}`).digest('base64url');
const digest = (key: Uint8Array, scope: string, channel: string) => createHmac('sha256', key).update(`${scope}\n${channel}`).digest('base64url');

/**
 * Signs channels for sessions: a token is an HMAC over the channel and the session's scope (a hash of its id, never the
 * id). Whoever was shown a page that follows a channel may hear its hints — for as long as that session lives: signing in or
 * out regenerates the id, and the tokens of the old one are void.
 */
export class LiveTokens {
  readonly #keys: readonly Uint8Array[];

  constructor(keys: readonly Uint8Array[]) {
    if (keys.length === 0) throw new Error('Live tokens need a key (APP_KEY).');
    this.#keys = keys;
  }

  /**
   * The scope under which the streams of an account are filed and closed — and the only form that crosses the live backend: an
   * HMAC of the account's unkeyed scope, so what the backend carries (Redis messages, its logs) names no account to someone who
   * only reads it. The backend itself is trusted: whoever can publish to it can close every account's streams (`'*'`) or replay a scope.
   */
  accountScope(unkeyed: string): string {
    return accountDigest(this.#keys[0]!, unkeyed);
  }

  /** The scope under every key (the current one first): an end is published under each, so a rollout of `APP_KEY` misses no process. */
  accountScopes(unkeyed: string): string[] {
    return this.#keys.map((key) => accountDigest(key, unkeyed));
  }

  /** The token of `channel` for the session `scope`. */
  sign(scope: string, channel: string): string {
    return digest(this.#keys[0]!, scope, channel);
  }

  /** Whether `token` is `channel`'s for `scope` — under the current key or a previous one; constant time. */
  verify(scope: string, channel: string, token: string): boolean {
    const given = Buffer.from(token);
    return this.#keys.some((key) => {
      const expected = Buffer.from(digest(key, scope, channel));
      return expected.length === given.length && timingSafeEqual(expected, given);
    });
  }

  /**
   * A signer for one request: its session's scope, read when a page is signed. A page keeps its session for the signature;
   * a read-only request (`readOnly()` — an island) cannot start one, so a guest without a session gets no token there (the
   * subscription is left out) — anything else without a session is a mistake that says so.
   */
  for(scope: () => string | undefined, readOnly: () => boolean = () => false): LiveSigner {
    return {
      sign: (channel) => {
        const current = scope();
        if (current === undefined) {
          if (readOnly()) return undefined;
          throw new Error(`The live channel "${channel}" is signed for the session — this request has none (a route outside the web group?).`);
        }
        return this.sign(current, channel);
      },
    };
  }
}
