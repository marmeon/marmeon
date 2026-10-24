import { SessionEndings, type UserSessions } from '@marmeon/session';
import { accountScope } from '@marmeon/session/internal';
import { describe, expect, it, vi } from 'vitest';
import { AccountSessions } from './account-sessions.ts';
import { signInStore } from './test-helpers/stores.ts';
import type { AuthUser, Credentials, UserProvider } from './user.ts';

const ada: AuthUser = { id: 7, name: 'Ada', email: 'ada@example.com' };

const users = (overrides: Partial<UserProvider> = {}) =>
  ({
    findById: async () => ({ user: ada, passwordHash: null, sessionKey: 'k' }) satisfies Credentials,
    findForSignIn: async () => undefined,
    updatePasswordHash: async () => {},
    updateSessionKey: async () => true,
    updateEverySessionKey: async () => ({ accounts: 1, sampleId: ada.id }),
    ...overrides,
  }) as unknown as UserProvider;
const signIns = signInStore({ endEveryone: async () => 1 });

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
    const accounts = new AccountSessions(provider, signIns, sessions, undefined, undefined, undefined, undefined, undefined, endings);
    await expect(accounts.end('7' as never)).rejects.toThrow('store down');
    expect(heard.mock.calls).toEqual([[accountScope(7)]]);
  });

  it('end(): an unknown account, or a key that could not be replaced, announces nothing', async () => {
    const { endings, heard } = endingsSpy();
    const missing = new AccountSessions(users({ findById: async () => undefined }), signIns, undefined, undefined, undefined, undefined, undefined, undefined, endings);
    expect((await missing.end(7 as never)).ok).toBe(false);
    const broken = new AccountSessions(users({ updateSessionKey: async () => Promise.reject(new Error('db down')) }), signIns, undefined, undefined, undefined, undefined, undefined, undefined, endings);
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
    const accounts = new AccountSessions(provider, signIns, undefined, undefined, undefined, () => resets as never, undefined, undefined, endings);
    await expect(accounts.endEveryone({ accessTokens: false })).rejects.toThrow(/table missing/);
    expect(heard.mock.calls).toEqual([['*']]);
  });

  it('endEveryone(): keys written but not confirmed on read-back are announced too — they may be live', async () => {
    const { endings, heard } = endingsSpy();
    const provider = users({ findById: async () => ({ user: ada, passwordHash: null, sessionKey: 'cached old key' }) });
    const accounts = new AccountSessions(provider, signIns, undefined, undefined, undefined, undefined, undefined, undefined, endings);
    await expect(accounts.endEveryone({ accessTokens: false, resetTokens: false })).rejects.toThrow(/cannot confirm the new key/);
    expect(heard.mock.calls).toEqual([['*']]);
  });

  it('endEveryone(): keys that were not rotated announce nothing', async () => {
    const { endings, heard } = endingsSpy();
    const provider = users({ updateEverySessionKey: async () => Promise.reject(new Error('db down')) });
    const accounts = new AccountSessions(provider, signIns, undefined, undefined, undefined, undefined, undefined, undefined, endings);
    await expect(accounts.endEveryone({ accessTokens: false, resetTokens: false })).rejects.toThrow(/db down/);
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('the sign-ins of the account are ended once more after the keys', () => {
  /** A sign-in store over a set of rows; `endAll` and `endEveryone` empty it. */
  const rowsOf = (rows: Set<string>) =>
    signInStore({
      endAll: async () => {
        const n = rows.size;
        rows.clear();
        return n;
      },
      endEveryone: async () => {
        const n = rows.size;
        rows.clear();
        return n;
      },
    });

  it('end(): a sign-in made between the first step and the new key is gone afterwards', async () => {
    const rows = new Set(['first']);
    let key: string | null = 'k';
    const provider = users({
      findById: async () => ({ user: ada, passwordHash: null, sessionKey: key }),
      updateSessionKey: async (_id: unknown, next: string) => {
        rows.add('late'); // a sign-in that was running lands before the key does
        key = next;
        return true;
      },
    });
    const ended = vi.fn();
    const store = signInStore({
      endAll: async () => {
        ended();
        const n = rows.size;
        rows.clear();
        return n;
      },
    });
    const accounts = new AccountSessions(provider, store, undefined);
    expect((await accounts.end(7 as never)).ok).toBe(true);
    expect([...rows], 'no row is left').toEqual([]);
    expect(ended).toHaveBeenCalledTimes(2);
  });

  it('endEveryone(): a sign-in made between the first step and the new keys is gone afterwards, and counted', async () => {
    const rows = new Set(['first']);
    let key: string | null = null;
    const provider = users({
      findById: async () => ({ user: ada, passwordHash: null, sessionKey: key }),
      updateEverySessionKey: async (next: string) => {
        rows.add('late');
        key = next;
        return { accounts: 1, sampleId: ada.id };
      },
    });
    const accounts = new AccountSessions(provider, rowsOf(rows), undefined);
    expect(await accounts.endEveryone({ accessTokens: false, resetTokens: false })).toMatchObject({ accounts: 1, signIns: 2 });
    expect([...rows], 'no row is left').toEqual([]);
  });

  it('end(): refuses a sign-in store without endAll() with its code, before the key is replaced', async () => {
    const updateSessionKey = vi.fn(async () => true);
    const accounts = new AccountSessions(users({ updateSessionKey }), {} as never, undefined);
    await expect(accounts.end(7 as never)).rejects.toThrow(/^\[marmeon:A6\] AccountSessions\.end\(\) needs SignInStore\.endAll\(\)/);
    expect(updateSessionKey).not.toHaveBeenCalled();
  });
});
