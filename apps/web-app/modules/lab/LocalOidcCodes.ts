import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Clock } from '@marmeon/core';

/** What the person answered at the local provider, and what the client asked for. */
export interface LocalOidcGrant {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** Seconds since the epoch: when the person gave the answer. */
  readonly authTime: number;
}

/** How long an authorization code can be traded. */
const CODE_SECONDS = 60;
/** The most codes held at once: a development tool that is asked in a loop does not grow without bound. */
const MAX_CODES = 1000;

/** Compares two texts in constant time whatever their lengths: both are hashed to one length first. */
export function sameText(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/**
 * The authorization codes of the local OpenID Connect provider, in the memory of this process: a code is 32 random bytes, valid for 60 seconds, and
 * `spend()` takes it out of the map before the grant is looked at, so one code is traded at most once, whatever the trade says. The token endpoint
 * checks the client secret before it spends: a caller with a wrong secret does not burn the code.
 */
export class LocalOidcCodes {
  readonly #clock: Clock;
  readonly #codes = new Map<string, { readonly grant: LocalOidcGrant; readonly expiresAt: number }>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Keeps the grant under a new code. */
  issue(grant: LocalOidcGrant): string {
    const now = this.#clock.now();
    for (const [code, entry] of this.#codes) if (entry.expiresAt <= now) this.#codes.delete(code);
    // The oldest codes go first when the map is full.
    while (this.#codes.size >= MAX_CODES) this.#codes.delete(this.#codes.keys().next().value!);
    const code = randomBytes(32).toString('base64url');
    this.#codes.set(code, { grant, expiresAt: now + CODE_SECONDS * 1000 });
    return code;
  }

  /** The grant of `code`, once: the code is gone afterwards, and an expired one answers `undefined`. */
  spend(code: string): LocalOidcGrant | undefined {
    const entry = this.#codes.get(code);
    this.#codes.delete(code);
    return entry === undefined || entry.expiresAt <= this.#clock.now() ? undefined : entry.grant;
  }
}
