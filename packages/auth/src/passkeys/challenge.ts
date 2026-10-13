import { randomBytes, timingSafeEqual } from 'node:crypto';
import { err, ok, type Result } from '@marmeon/core';
import type { Session } from '@marmeon/session';

/** What a challenge was issued for; it works for nothing else. */
export type ChallengePurpose = 'register' | 'sign-in' | 'second-factor' | 'step-up';

/** How long the user has for one ceremony, in seconds. */
export const CHALLENGE_SECONDS = 300;

interface OpenChallenge {
  challenge: string;
  purpose: ChallengePurpose;
  userId?: string | number;
  /** Seconds since the epoch. */
  until: number;
}

declare module '@marmeon/session' {
  interface SessionData {
    _auth_webauthn: OpenChallenge;
  }
}

const KEY = '_auth_webauthn';

export type ChallengeError = { kind: 'no-challenge' } | { kind: 'expired' } | { kind: 'invalid' };

/** Opens a challenge for `purpose`; a session holds one, so a new one replaces the old. */
export function issueChallenge(session: Session, purpose: ChallengePurpose, nowSeconds: number, userId?: string | number): { bytes: Uint8Array; challenge: string } {
  const bytes = randomBytes(32);
  const challenge = bytes.toString('base64url');
  session.put(KEY, { challenge, purpose, ...(userId === undefined ? {} : { userId }), until: nowSeconds + CHALLENGE_SECONDS });
  return { bytes, challenge };
}

/**
 * Takes the open challenge out of the session — before anything is checked, so it works once even when the check fails.
 * It must be for `purpose` (and `userId`, where given) and not past its time.
 */
export function takeChallenge(
  session: Session,
  purpose: ChallengePurpose,
  nowSeconds: number,
  userId?: string | number,
): Result<string, ChallengeError> {
  const open = session.started ? session.pull(KEY) : undefined;
  if (open === undefined || typeof open.challenge !== 'string') return err({ kind: 'no-challenge' });
  if (typeof open.until !== 'number' || open.until <= nowSeconds) return err({ kind: 'expired' });
  if (open.purpose !== purpose) return err({ kind: 'invalid' });
  // Both sides name an account or neither does: a challenge for an account never serves a ceremony without one, nor the reverse.
  if ((userId === undefined) !== (open.userId === undefined)) return err({ kind: 'invalid' });
  if (userId !== undefined && !sameId(open.userId!, userId)) return err({ kind: 'invalid' });
  return ok(open.challenge);
}

function sameId(a: string | number, b: string | number): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
