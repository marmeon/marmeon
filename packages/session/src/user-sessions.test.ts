import { runTransaction } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { accountScope, SessionEndings } from './ended.ts';
import type { SessionStore } from './store.ts';
import { UserSessions } from './user-sessions.ts';

describe('UserSessions.canEnd()', () => {
  it('is true for a store that finds a user’s sessions, false for one that cannot', async () => {
    const database = { destroyUser: async () => 2 } as unknown as SessionStore;
    const memory = {} as SessionStore;
    expect(new UserSessions(() => database).canEnd()).toBe(true);
    expect(new UserSessions(() => memory).canEnd()).toBe(false);
    expect(await new UserSessions(() => memory).end(1)).toBe(0);
  });
});

describe('UserSessions.end() inside a transaction', () => {
  it('tells the streams after the commit — and not at all when the transaction rolls back', async () => {
    const endings = new SessionEndings();
    const heard = vi.fn();
    endings.listenAccounts(heard);
    const sessions = new UserSessions(() => ({}) as SessionStore, endings);
    const owner = {};
    await runTransaction(owner, 'commit', async () => {
      await sessions.end(7);
      expect(heard).not.toHaveBeenCalled();
    });
    expect(heard).toHaveBeenCalledTimes(1);
    await expect(
      runTransaction(owner, 'rollback', async () => {
        await sessions.end(8);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('UserSessions.end() and the live streams', () => {
  it('tells the account\'s streams its sign-ins ended — also when the store cannot find them, and when it fails', async () => {
    const endings = new SessionEndings();
    const heard = vi.fn();
    endings.listenAccounts(heard);
    const memory = {} as SessionStore;
    await new UserSessions(() => memory, endings).end(7);
    const broken = { destroyUser: async () => Promise.reject(new Error('store down')) } as unknown as SessionStore;
    await expect(new UserSessions(() => broken, endings).end('7')).rejects.toThrow('store down');
    expect(heard.mock.calls).toEqual([[accountScope(7)], [accountScope(7)]]);
  });
});
