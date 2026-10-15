import { accountScope, type Session } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { AUTH_SESSION_KEYS, type Auth } from './auth.ts';
import { SignInAudience } from './live-audience.ts';

const sessionOf = (started: boolean, keys: readonly string[]) => ({ started, has: (key: string) => keys.includes(key) }) as unknown as Session;
const authOf = (user: unknown) => {
  const calls = { built: 0 };
  return { calls, make: () => ((calls.built += 1), { user: async () => user } as unknown as Auth) };
};

describe('SignInAudience', () => {
  it('a session that never started, or names no account, is a guest — and never builds Auth', async () => {
    for (const session of [sessionOf(false, []), sessionOf(true, []), sessionOf(true, ['other'])]) {
      const auth = authOf(undefined);
      expect(await new SignInAudience(auth.make, session).check()).toEqual({ kind: 'guest' });
      expect(auth.calls.built).toBe(0);
    }
  });

  it('a session waiting for its second factor holds no account id: a guest', async () => {
    const auth = authOf(undefined);
    expect(await new SignInAudience(auth.make, sessionOf(true, [AUTH_SESSION_KEYS.pending])).check()).toEqual({ kind: 'guest' });
    expect(auth.calls.built).toBe(0);
  });

  it('an account id nobody is signed in as any more (changed password, lifetime over, ended sign-in) is ended', async () => {
    const audience = new SignInAudience(authOf(undefined).make, sessionOf(true, [AUTH_SESSION_KEYS.id]));
    expect(await audience.check()).toEqual({ kind: 'ended' });
  });

  it('a signed-in account is its scope', async () => {
    const audience = new SignInAudience(authOf({ id: 7 }).make, sessionOf(true, [AUTH_SESSION_KEYS.id]));
    expect(await audience.check()).toEqual({ kind: 'account', scope: accountScope('7') });
  });
});
