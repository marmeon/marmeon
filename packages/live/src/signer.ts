import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { LiveSigner } from '@bespokecore/http';

/** The keys of live tokens (E90): from `APP_KEY` (and the previous keys, still accepted) by HKDF, context `live`. */
export function liveKeys(key: Uint8Array, previousKeys: readonly Uint8Array[] = []): readonly Uint8Array[] {
  return [key, ...previousKeys].map((secret) => new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), 'bespokecore:live', 32)));
}

const digest = (key: Uint8Array, scope: string, channel: string) => createHmac('sha256', key).update(`${scope}\n${channel}`).digest('base64url');

/**
 * Signs channels for sessions (E90): a token is an HMAC over the channel and the session's scope (a hash of its id, never the
 * id). Whoever was shown a page that follows a channel may hear its hints — for as long as that session lives: signing in or
 * out regenerates the id, and the tokens of the old one are void.
 */
export class LiveTokens {
  readonly #keys: readonly Uint8Array[];

  constructor(keys: readonly Uint8Array[]) {
    if (keys.length === 0) throw new Error('Live tokens need a key (APP_KEY).');
    this.#keys = keys;
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
   * A signer for one request: its session's scope, read when a page is signed. A page keeps its session for the signature (W8
   * step 6); a read-only request (`readOnly()` — an island) cannot start one, so a guest without a session gets no token there
   * (the subscription is left out) — anything else without a session is a mistake that says so.
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
