import type { Session } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { guardNames } from '../guard-names.ts';
import { issueChallenge, takeChallenge, type ChallengePurpose } from './challenge.ts';

/** Just what the challenge helpers use of a session. */
function fakeSession(): Session {
  const data = new Map<string, unknown>();
  return { started: true, put: (key: string, value: unknown) => data.set(key, value), pull: (key: string) => { const value = data.get(key); data.delete(key); return value; } } as unknown as Session;
}

describe('challenges', () => {
  const purposes: ChallengePurpose[] = ['register', 'sign-in', 'second-factor', 'step-up'];

  it('serve only their own purpose, also when both name the same account', () => {
    for (const issued of ['second-factor', 'step-up', 'register'] as const) {
      for (const asked of purposes.filter((purpose) => purpose !== issued)) {
        const session = fakeSession();
        issueChallenge(session, issued, 1000, 7);
        expect(takeChallenge(session, asked, 1001, 7), `${issued} -> ${asked}`).toEqual({ ok: false, error: { kind: 'invalid' } });
      }
      const session = fakeSession();
      const { challenge } = issueChallenge(session, issued, 1000, 7);
      expect(takeChallenge(session, issued, 1001, 7)).toMatchObject({ ok: true, value: { challenge } });
    }
  });

  it('are kept per guard: a ceremony opened for one guard serves neither the app nor another guard', () => {
    const session = fakeSession();
    const office = guardNames('office');
    const { challenge } = issueChallenge(session, 'sign-in', 1000, undefined, undefined, office);
    expect(takeChallenge(session, 'sign-in', 1001), 'app').toEqual({ ok: false, error: { kind: 'no-challenge' } });
    expect(takeChallenge(session, 'sign-in', 1001, undefined, guardNames('shop')), 'other guard').toEqual({ ok: false, error: { kind: 'no-challenge' } });
    expect(takeChallenge(session, 'sign-in', 1001, undefined, office)).toMatchObject({ ok: true, value: { challenge } });
  });

  it('are gone after one take, and after their five minutes', () => {
    const session = fakeSession();
    issueChallenge(session, 'step-up', 1000, 7);
    expect(takeChallenge(session, 'step-up', 1001, 7).ok).toBe(true);
    expect(takeChallenge(session, 'step-up', 1001, 7)).toEqual({ ok: false, error: { kind: 'no-challenge' } });
    issueChallenge(session, 'step-up', 1000, 7);
    expect(takeChallenge(session, 'step-up', 1300, 7)).toEqual({ ok: false, error: { kind: 'expired' } });
  });
});
