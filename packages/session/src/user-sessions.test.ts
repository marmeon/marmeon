import { describe, expect, it } from 'vitest';
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
