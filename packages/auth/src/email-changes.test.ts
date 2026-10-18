import { createHash } from 'node:crypto';
import { TestClock } from '@marmeon/core/testing';
import { secret, type Connections } from '@marmeon/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { AccountSessions } from './account-sessions.ts';
import { DatabaseEmailChanges, EMAIL_CHANGES_TABLE, EmailChangeStore, type EmailChangeTable } from './email-changes.ts';
import type { PasswordHash } from './hashing.ts';
import { NewPassword } from './new-password.ts';
import { DatabasePasswordResetTokens, PasswordBroker } from './password-reset.ts';
import { PruneTokensCommand } from './prune-tokens.ts';
import { NO_LOGIN_LIMITS } from './test-helpers/login-limits.ts';
import { signInStore } from './test-helpers/stores.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import type { AuthUser } from './user.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const grace: AuthUser = { id: 2, name: 'Grace', email: 'grace@example.com' };
const HOUR = 3_600_000;

describe.each(drivers)('changes of address on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let clock: TestClock;
  let changes: DatabaseEmailChanges;
  const db = () => connections.get<{ [EMAIL_CHANGES_TABLE]: EmailChangeTable }>();
  const rows = () => db().selectFrom(EMAIL_CHANGES_TABLE).select((eb) => ['user_id', 'email', secret(eb, 'token_hash')]).execute();
  const expiry = () => new Date(clock.now() + HOUR);
  /** The session keys the accounts of the `users` table hold; `null`: an account without one. */
  const KEYS: Record<number, string | null> = { 1: 'key-of-the-first-account-0123456789abcdef', 2: 'key-of-the-second-account-0123456789abcd', 3: null };
  /** Stores a change as a session that was checked against the account's current key would. */
  const make = async (id: number, email: string, at: Date) => {
    const token = await changes.create(id, email, at, KEYS[id]!);
    if (token === undefined) throw new Error('the change was not stored');
    return token;
  };
  const rotate = (id: number, key: string) => connections.get<any>().updateTable('users').set({ session_key: key }).where('id', '=', id).execute();

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
  });
  afterAll(() => close());
  beforeEach(async () => {
    await db().deleteFrom(EMAIL_CHANGES_TABLE).execute();
    const accounts = connections.get<any>();
    await accounts.deleteFrom('users').execute();
    for (const [id, session_key] of Object.entries(KEYS)) await accounts.insertInto('users').values({ id: Number(id), session_key }).execute();
    clock = new TestClock();
    clock.freeze(Date.parse('2026-10-05T10:00:00Z'));
    changes = new DatabaseEmailChanges(connections, clock);
  });

  describe('the store', () => {
    it('keeps one change per account: a new one replaces the older, and the older link is dead', async () => {
      const first = await make(1, 'first@example.com', expiry());
      const second = await make(1, 'second@example.com', expiry());
      expect(first).not.toBe(second);
      expect(second).toMatch(/^[\w-]{43}$/);
      expect((await rows()).map((row) => row.email)).toEqual(['second@example.com']);
      expect(await changes.claim(1, first, new Date(clock.now()))).toBeUndefined();
      expect(await changes.claim(1, second, new Date(clock.now()))).toBe('second@example.com');
    });

    it('stores nothing when the session key of the account is not the one the session was checked against', async () => {
      await rotate(1, 'a-newer-key-of-the-first-account-0123456789');
      expect(await changes.create(1, 'new@example.com', expiry(), KEYS[1]!)).toBeUndefined();
      expect(await changes.create(1, 'new@example.com', expiry(), null), 'an account with a key is not one without').toBeUndefined();
      expect(await rows()).toEqual([]);
    });

    it('does not replace a change when the key is no longer the account\'s', async () => {
      const token = await make(1, 'first@example.com', expiry());
      await rotate(1, 'a-newer-key-of-the-first-account-0123456789');
      expect(await changes.create(1, 'second@example.com', expiry(), KEYS[1]!)).toBeUndefined();
      expect((await rows()).map((row) => row.email)).toEqual(['first@example.com']);
      expect(token).toBeDefined();
    });

    it('stores a change for an account without a key only for a session that read none, and not for an unknown account', async () => {
      expect(await changes.create(3, 'new@example.com', expiry(), 'some-key-that-is-not-the-accounts-0123456789')).toBeUndefined();
      expect(await changes.create(3, 'new@example.com', expiry(), null)).toMatch(/^[\w-]{43}$/);
      expect(await changes.create(99, 'new@example.com', expiry(), null)).toBeUndefined();
    });

    it('claims a change while the account holds the key it was asked under, with or without one', async () => {
      const keyed = await make(1, 'new@example.com', expiry());
      const keyless = await make(3, 'other@example.com', expiry());
      expect(await changes.claim(1, keyed, new Date(clock.now()))).toBe('new@example.com');
      expect(await changes.claim(3, keyless, new Date(clock.now()))).toBe('other@example.com');
    });

    it('does not claim, or show as pending, a change once the key of the account was replaced without a forget', async () => {
      const token = await make(1, 'new@example.com', expiry());
      await rotate(1, 'a-newer-key-of-the-first-account-0123456789');
      expect(await changes.pending(1, 'new@example.com', token)).toBeUndefined();
      expect(await changes.claim(1, token, new Date(clock.now()))).toBeUndefined();
    });

    it('does not claim a change of an account that had no key and has one now, nor the reverse', async () => {
      const keyless = await make(3, 'other@example.com', expiry());
      await rotate(3, 'a-first-key-of-the-third-account-0123456789');
      expect(await changes.claim(3, keyless, new Date(clock.now()))).toBeUndefined();
      const keyed = await make(1, 'new@example.com', expiry());
      await connections.get<any>().updateTable('users').set({ session_key: null }).where('id', '=', 1).execute();
      expect(await changes.claim(1, keyed, new Date(clock.now()))).toBeUndefined();
    });

    it('does not claim the change of an account that was deleted, with a key or without one', async () => {
      const keyed = await make(1, 'new@example.com', expiry());
      const keyless = await make(3, 'other@example.com', expiry());
      await connections.get<any>().deleteFrom('users').where('id', 'in', [1, 3]).execute(); // the fixture has no foreign key to cascade
      expect(await changes.claim(1, keyed, new Date(clock.now()))).toBeUndefined();
      expect(await changes.claim(3, keyless, new Date(clock.now()))).toBeUndefined();
      expect(await changes.pending(3, 'other@example.com', keyless)).toBeUndefined();
    });

    it('refuses a table name that is not plain', () => {
      expect(() => new DatabaseEmailChanges(connections, clock, { usersTable: 'users; drop table users' })).toThrow(TypeError);
      expect(() => new DatabaseEmailChanges(connections, clock, { usersTable: 'accounts' })).not.toThrow();
    });

    it('stores the token only as its SHA-256', async () => {
      const token = await make(1, 'new@example.com', expiry());
      const [row] = await rows();
      expect(row!.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(JSON.stringify(await rows())).not.toContain(token);
    });

    it('says that a change is pending only for exactly this token and address, until it expires', async () => {
      const token = await make(1, 'new@example.com', expiry());
      expect(await changes.pending(1, 'new@example.com', token)).toEqual(expiry());
      expect(await changes.pending(1, 'other@example.com', token)).toBeUndefined();
      expect(await changes.pending(2, 'new@example.com', token)).toBeUndefined();
      expect(await changes.pending(1, 'new@example.com', 'A'.repeat(43))).toBeUndefined();
      clock.travel({ hours: 2 });
      expect(await changes.pending(1, 'new@example.com', token)).toBeUndefined();
    });

    it('claims a change once: the row is gone and a second claim finds nothing', async () => {
      const token = await make(1, 'new@example.com', expiry());
      expect(await changes.claim(1, token, new Date(clock.now()))).toBe('new@example.com');
      expect(await rows()).toEqual([]);
      expect(await changes.claim(1, token, new Date(clock.now()))).toBeUndefined();
    });

    it('does not claim a change of another account, and the row stays', async () => {
      const token = await make(1, 'new@example.com', expiry());
      expect(await changes.claim(2, token, new Date(clock.now()))).toBeUndefined();
      expect(await rows()).toHaveLength(1);
      expect(await changes.claim(1, token, new Date(clock.now()))).toBe('new@example.com');
    });

    it('does not claim an expired change', async () => {
      const token = await make(1, 'new@example.com', expiry());
      expect(await changes.claim(1, token, new Date(clock.now() + 2 * HOUR))).toBeUndefined();
      expect(await changes.claim(1, token, new Date(clock.now() + HOUR)), 'the expiry itself is too late').toBeUndefined();
    });

    it('does not even query for a malformed token', async () => {
      await make(1, 'new@example.com', expiry());
      const statements: string[] = [];
      const spying = new DatabaseEmailChanges(
        {
          get: () => {
            statements.push('get');
            return db();
          },
        } as unknown as Connections,
        clock,
      );
      for (const bad of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, "' OR 1=1 --"]) {
        expect(await spying.claim(1, bad, new Date(clock.now()))).toBeUndefined();
        expect(await spying.pending(1, 'new@example.com', bad)).toBeUndefined();
      }
      expect(statements).toEqual([]);
      expect(await rows()).toHaveLength(1);
    });

    it('lets exactly one of ten parallel claims win', async () => {
      const token = await make(1, 'new@example.com', expiry());
      const answers = await Promise.all(Array.from({ length: 10 }, () => changes.claim(1, token, new Date(clock.now()))));
      expect(answers.filter((answer) => answer !== undefined)).toEqual(['new@example.com']);
    });

    it('survives ten parallel creates for one account with one row', async () => {
      await Promise.all(Array.from({ length: 10 }, (_, n) => make(1, `n${n}@example.com`, expiry())));
      expect(await rows()).toHaveLength(1);
    });

    it('forgets the change of one account, and of every account', async () => {
      await make(1, 'a@example.com', expiry());
      await make(2, 'b@example.com', expiry());
      await changes.forget(1);
      expect((await rows()).map((row) => row.user_id).map(Number)).toEqual([2]);
      await make(1, 'a@example.com', expiry());
      expect(await changes.forgetEveryone()).toBe(2);
      expect(await rows()).toEqual([]);
    });

    it('prunes the expired changes and keeps the valid ones', async () => {
      await make(1, 'old@example.com', new Date(clock.now() + HOUR));
      await make(2, 'fresh@example.com', new Date(clock.now() + 3 * HOUR));
      clock.travel({ hours: 2 });
      expect(await changes.prune(new Date(clock.now()))).toBe(1);
      expect((await rows()).map((row) => row.email)).toEqual(['fresh@example.com']);
    });
  });

  describe('what drops a change', () => {
    const hash = 'hash' as unknown as PasswordHash;
    const users = () => {
      const memory = new MemoryUsers<AuthUser>();
      memory.add(ada, 'old' as unknown as PasswordHash, 'old-session-key-of-the-account-0123456789');
      memory.add(grace, 'old' as unknown as PasswordHash, 'old-session-key-of-the-other-account-0123');
      return memory;
    };
    const newPassword = (store: EmailChangeStore | undefined) =>
      new NewPassword(() => ({}) as never, () => connections, { revokeTokensOnPasswordChange: false } as never, { info() {}, warn() {}, error() {} } as never, () => signInStore({ endAll: async () => 0, dropToken: async () => {} }), undefined, undefined, store && (() => store));
    const accounts = (store: EmailChangeStore | undefined, memory = users()) =>
      new AccountSessions(memory, signInStore({ endAll: async () => 0, endEveryone: async () => 0 }), undefined, undefined, clock, undefined, undefined, undefined, undefined, store && (() => store));
    const pendingOf = async () => (await rows()).map((row) => Number(row.user_id));
    beforeEach(async () => {
      await make(1, 'ada-new@example.com', expiry());
      await make(2, 'grace-new@example.com', expiry());
    });

    it.each(['change', 'reset'] as const)('a new password (%s) drops the change of that account only', async (via) => {
      await newPassword(changes).store(users(), 1, hash, via);
      expect(await pendingOf()).toEqual([2]);
    });

    it('a new password changes nothing about changes of address when none is bound', async () => {
      await newPassword(undefined).store(users(), 1, hash, 'reset');
      expect(await pendingOf()).toEqual([1, 2]);
    });

    it('a failed new password keeps the change', async () => {
      const refusing = users();
      refusing.updatePasswordHash = async () => false;
      await expect(newPassword(changes).store(refusing, 1, hash, 'reset')).rejects.toThrow();
      expect(await pendingOf()).toEqual([1, 2]);
    });

    it('AccountSessions.end() drops the change of that account only', async () => {
      expect((await accounts(changes).end(1)).ok).toBe(true);
      expect(await pendingOf()).toEqual([2]);
    });

    it('AccountSessions.end() leaves the changes alone when none is bound', async () => {
      expect((await accounts(undefined).end(1)).ok).toBe(true);
      expect(await pendingOf()).toEqual([1, 2]);
    });

    it('AccountSessions.endEveryone() drops every change', async () => {
      await accounts(changes).endEveryone({ accessTokens: false, resetTokens: false });
      expect(await pendingOf()).toEqual([]);
    });

    it('AccountSessions.endEveryone() leaves the changes alone when none is bound', async () => {
      await accounts(undefined).endEveryone({ accessTokens: false, resetTokens: false });
      expect(await pendingOf()).toEqual([1, 2]);
    });

    it('refuses a bound store without forget() or forgetEveryone() with its code, before anything is written', async () => {
      const incomplete = {} as unknown as EmailChangeStore;
      const memory = users();
      await expect(newPassword(incomplete).store(memory, 1, hash, 'reset')).rejects.toThrow(/^\[marmeon:A6\] NewPassword needs EmailChangeStore\.forget\(\)/);
      expect(memory.rows.get(1)?.hash, 'not written').toBe('old');
      await expect(accounts(incomplete, memory).end(1)).rejects.toThrow(/^\[marmeon:A6\] AccountSessions\.end\(\) needs EmailChangeStore\.forget\(\)/);
      await expect(accounts(incomplete, memory).endEveryone({ accessTokens: false, resetTokens: false })).rejects.toThrow(/^\[marmeon:A6\] AccountSessions\.endEveryone\(\) needs EmailChangeStore\.forgetEveryone\(\)/);
      expect(await pendingOf()).toEqual([1, 2]);
    });

    it('endEveryone() revokes the API tokens even when the store of the changes fails, and says which step failed', async () => {
      let revoked = 0;
      const failing = Object.assign(Object.create(EmailChangeStore.prototype), {
        forget: async () => {},
        forgetEveryone: async () => {
          throw new Error('the table is gone');
        },
      }) as EmailChangeStore;
      const access = { revokeEveryone: async () => ++revoked } as never;
      const sessions = new AccountSessions(users(), signInStore({ endEveryone: async () => 0 }), undefined, undefined, clock, undefined, () => access, undefined, undefined, () => failing);
      await expect(sessions.endEveryone({ resetTokens: false })).rejects.toThrow(/failed at "changes of address".*accessTokens 1/);
      expect(revoked).toBe(1);
    });

    it('refuses a reset over a store that lacks forget() before the reset token is spent', async () => {
      const resets = new DatabasePasswordResetTokens(connections, clock);
      const memory = users();
      const broker = new PasswordBroker(memory, resets, { make: async () => hash } as never, { dispatch: async () => {} } as never, { resetExpire: 60, resetThrottle: 0 } as never, newPassword({} as unknown as EmailChangeStore), NO_LOGIN_LIMITS as never);
      const created = await broker.createToken(ada.email!);
      if (!created.ok) throw new Error('no token');
      await expect(broker.reset(ada.email!, created.value.token, 'a new password')).rejects.toThrow(/^\[marmeon:A6\] NewPassword needs EmailChangeStore\.forget\(\)/);
      expect((await resets.consume(ada.email!, created.value.token, 3600)).ok, 'the reset link still works').toBe(true);
      expect(memory.rows.get(1)?.hash, 'not written').toBe('old');
    });

    it('auth:prune-tokens prunes expired changes when a store is bound, and says so', async () => {
      await make(3, 'old@example.com', new Date(clock.now() - HOUR));
      const lines: string[] = [];
      const output = { success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
      const none = { prune: async () => 0, create: async () => ({ ok: false }) } as never;
      const command = (container?: object) =>
        new PruneTokensCommand(none, { prune: async () => 0 } as never, { resetExpire: 60, rememberDays: 30, sessionMaxSeconds: 86_400 } as never, { lifetime: 120 } as never, { prune: async () => 0 } as never, container as never, clock);
      const run = (container?: object) => command(container).handle({ args: [], options: {}, output, root: '/', spawn: async () => 0 } as never);
      await run();
      expect(lines.pop()).toBe('Pruned 0 password reset tokens, 0 API tokens and 0 sign-ins.');
      await run({ has: (key: unknown) => key === EmailChangeStore, make: () => changes });
      expect(lines.pop()).toBe('Pruned 0 password reset tokens, 0 API tokens, 0 sign-ins and 1 change of address.');
      expect(await pendingOf()).toEqual([1, 2]);
    });
  });
});
