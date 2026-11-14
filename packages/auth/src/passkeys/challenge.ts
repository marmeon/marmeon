import { randomBytes, timingSafeEqual } from 'node:crypto';
import { err, ok, type Result } from '@marmeon/core';
import type { Session } from '@marmeon/session';
import { APP_GUARD_NAMES, type GuardNames } from '../guard-names.ts';

/** What a challenge was issued for; it works for nothing else. */
export type ChallengePurpose = 'register' | 'sign-in' | 'second-factor' | 'step-up' | 'confirm';

/** How long the user has for one ceremony, in seconds. */
export const CHALLENGE_SECONDS = 300;

interface OpenChallenge {
  challenge: string;
  purpose: ChallengePurpose;
  userId?: string | number;
  /** Registration only: the user handle the options carried — the passkey is stored with exactly this one. */
  userHandle?: string;
  /** Seconds since the epoch. */
  until: number;
}

declare module '@marmeon/session' {
  interface SessionData {
    _auth_webauthn: OpenChallenge;
  }
}

/** Where the challenge lives: `names`' own key, so a ceremony of one guard never serves another's. */
const keyOf = (names: Pick<GuardNames, 'session'>): string => names.session.webauthn;

export type ChallengeError = { kind: 'no-challenge' } | { kind: 'expired' } | { kind: 'invalid' };

/** Opens a challenge for `purpose`; a session holds one, so a new one replaces the old. */
export function issueChallenge(session: Session, purpose: ChallengePurpose, nowSeconds: number, userId?: string | number, userHandle?: string, names: Pick<GuardNames, 'session'> = APP_GUARD_NAMES): { bytes: Uint8Array; challenge: string } {
  const bytes = randomBytes(32);
  const challenge = bytes.toString('base64url');
  session.put(keyOf(names), { challenge, purpose, ...(userId === undefined ? {} : { userId }), ...(userHandle === undefined ? {} : { userHandle }), until: nowSeconds + CHALLENGE_SECONDS });
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
  names: Pick<GuardNames, 'session'> = APP_GUARD_NAMES,
): Result<{ challenge: string; userHandle?: string }, ChallengeError> {
  // The key is a name, not a `SessionData` field: what came out of the store is checked below.
  const open = (session.started ? session.pull(keyOf(names)) : undefined) as Partial<OpenChallenge> | undefined;
  if (open === undefined || typeof open.challenge !== 'string') return err({ kind: 'no-challenge' });
  if (typeof open.until !== 'number' || open.until <= nowSeconds) return err({ kind: 'expired' });
  if (open.purpose !== purpose) return err({ kind: 'invalid' });
  // Both sides name an account or neither does: a challenge for an account never serves a ceremony without one, nor the reverse.
  if ((userId === undefined) !== (open.userId === undefined)) return err({ kind: 'invalid' });
  if (userId !== undefined && !sameId(open.userId!, userId)) return err({ kind: 'invalid' });
  return ok({ challenge: open.challenge, ...(open.userHandle === undefined ? {} : { userHandle: open.userHandle }) });
}

function sameId(a: string | number, b: string | number): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
