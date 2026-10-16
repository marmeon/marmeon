import { SessionEndings, type UserSessions } from '@marmeon/session';
import { accountScope } from '@marmeon/session/internal';
import { describe, expect, it, vi } from 'vitest';
import { AccountSessions } from './account-sessions.ts';
import type { RememberTokenStore } from './remember.ts';
import type { AuthUser, Credentials, UserProvider } from './user.ts';

const ada: AuthUser = { id: 7, name: 'Ada', email: 'ada@example.com' };

const users = (overrides: Partial<UserProvider> = {}) =>
  ({
    findById: async () => ({ user: ada, passwordHash: null, sessionKey: 'k' }) satisfies Credentials,
    findForLogin: async () => undefined,
    updatePasswordHash: async () => {},
    updateSessionKey: async () => true,
    updateEverySessionKey: async () => ({ accounts: 1, sampleId: ada.id }),
    ...overrides,
  }) as unknown as UserProvider;
const remember = { forgetUser: async () => {}, forgetEveryone: async () => 1 } as unknown as RememberTokenStore;

function endingsSpy() {
  const endings = new SessionEndings();
  const heard = vi.fn();
  endings.listenAccounts(heard);
  return { endings, heard };
}

describe('the live streams hear that sign-ins ended — as soon as the keys are rotated', () => {
  it('end(): once the key is replaced, whatever the tidying up does — under the account\'s own id', async () => {
    const { endings, heard } = endingsSpy();
    const sessions = { end: async () => Promise.reject(new Error('store down')) } as unknown as UserSessions;
    // Keys are rotated through the provider: its `updateSessionKey` answers true and hands the new key back.
    let key: string | null = 'k';
    const provider = users({
      findById: async () => ({ user: ada, passwordHash: null, sessionKey: key }),
      updateSessionKey: async (_id: unknown, next: string) => ((key = next), true),
    });
    const accounts = new AccountSessions(provider, remember, sessions, undefined, undefined, undefined, undefined, undefined, undefined, endings);
    await expect(accounts.end('7' as never)).rejects.toThrow('store down');
    expect(heard.mock.calls).toEqual([[accountScope(7)]]);
  });

  it('end(): an unknown account, or a key that could not be replaced, announces nothing', async () => {
    const { endings, heard } = endingsSpy();
    const missing = new AccountSessions(users({ findById: async () => undefined }), remember, undefined, undefined, undefined, undefined, undefined, undefined, undefined, endings);
    expect((await missing.end(7 as never)).ok).toBe(false);
    const broken = new AccountSessions(users({ updateSessionKey: async () => Promise.reject(new Error('db down')) }), remember, undefined, undefined, undefined, undefined, undefined, undefined, undefined, endings);
    await expect(broken.end(7 as never)).rejects.toThrow('db down');
    expect(heard).not.toHaveBeenCalled();
  });

  it('endEveryone(): once the keys are rotated, a later step that throws does not keep the streams open', async () => {
    const { endings, heard } = endingsSpy();
    const resets = { forgetEveryone: async () => Promise.reject(new Error('table missing')) };
    let key: string | null = null;
    const provider = users({
      findById: async () => ({ user: ada, passwordHash: null, sessionKey: key }),
      updateEverySessionKey: async (next: string) => ((key = next), { accounts: 1, sampleId: ada.id }),
    });
    const accounts = new AccountSessions(provider, remember, undefined, undefined, undefined, undefined, () => resets as never, undefined, undefined, endings);
    await expect(accounts.endEveryone({ accessTokens: false })).rejects.toThrow(/table missing/);
    expect(heard.mock.calls).toEqual([['*']]);
  });

  it('endEveryone(): keys written but not confirmed on read-back are announced too — they may be live', async () => {
    const { endings, heard } = endingsSpy();
    const provider = users({ findById: async () => ({ user: ada, passwordHash: null, sessionKey: 'cached old key' }) });
    const accounts = new AccountSessions(provider, remember, undefined, undefined, undefined, undefined, undefined, undefined, undefined, endings);
    await expect(accounts.endEveryone({ accessTokens: false, resetTokens: false })).rejects.toThrow(/cannot confirm the new key/);
    expect(heard.mock.calls).toEqual([['*']]);
  });

  it('endEveryone(): keys that were not rotated announce nothing', async () => {
    const { endings, heard } = endingsSpy();
    const provider = users({ updateEverySessionKey: async () => Promise.reject(new Error('db down')) });
    const accounts = new AccountSessions(provider, remember, undefined, undefined, undefined, undefined, undefined, undefined, undefined, endings);
    await expect(accounts.endEveryone({ accessTokens: false, resetTokens: false })).rejects.toThrow(/db down/);
    expect(heard).not.toHaveBeenCalled();
  });
});
