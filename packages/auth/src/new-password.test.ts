import type { EventDispatcher, Logger } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { PasswordBroker } from './password-reset.ts';
import { NO_LOGIN_LIMITS } from './test-helpers/login-limits.ts';
import { PasskeyRemoved, TwoFactorDisabled } from './events.ts';
import type { PasswordHash } from './hashing.ts';
import { AccountClaimLost, NewPassword } from './new-password.ts';
import type { AccessTokenStore } from './tokens.ts';
import { combineFactors, NoTwoFactorState, type SecondFactor, type TwoFactorState } from './two-factor/state.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import type { AuthUser, UserProvider } from './user.ts';
import { signInStore, twoFactorState } from './test-helpers/stores.ts';

// What a reset of an account with an unconfirmed address takes away — and what it leaves alone.

const hash = 'hash' as unknown as PasswordHash;

/** A source holding `factors` until `removeAll()`; `stubborn` keeps them, as a source that failed to delete would. */
function source(initial: readonly SecondFactor[], { stubborn = false } = {}) {
  let held = [...initial];
  const state = Object.assign(
    twoFactorState({
      factors: async () => held,
      removeAll: async () => {
        state.removed++;
        if (!stubborn) held = [];
      },
    }),
    { removed: 0 },
  );
  return state;
}

function setup({ state, revokeTokensOnPasswordChange = false }: { state: TwoFactorState; revokeTokensOnPasswordChange?: boolean }) {
  const events: object[] = [];
  const logged: { level: string; message: string; context?: unknown }[] = [];
  const logger = { info: (message: string, context?: unknown) => logged.push({ level: 'info', message, context }), warn: (message: string) => logged.push({ level: 'warn', message }), error: (message: string, context?: unknown) => logged.push({ level: 'error', message, context }) } as unknown as Logger;
  let revoked = 0;
  const tokens = { revokeAll: async () => ++revoked } as unknown as AccessTokenStore;
  let rollbacks = 0;
  const connections = {
    transaction: async (run: () => Promise<unknown>) => {
      try {
        return await run();
      } catch (error) {
        rollbacks++; // a rejection leaves the real transaction: everything it wrote is rolled back
        throw error;
      }
    },
  } as unknown as Connections;
  const users = new MemoryUsers<AuthUser>();
  users.add({ id: 1, name: 'Ada', email: 'ada@example.com' }, 'old' as unknown as PasswordHash, 'old-session-key-of-the-account-0123456789');
  const ended: { op: 'endAll' | 'dropToken'; args: unknown[] }[] = [];
  const signIns = signInStore({
    endAll: async (...args) => (ended.push({ op: 'endAll', args }), 0),
    dropToken: async (...args) => void ended.push({ op: 'dropToken', args }),
  });
  const newPassword = new NewPassword(
    () => tokens,
    () => connections,
    { revokeTokensOnPasswordChange } as never,
    logger,
    () => signIns,
    undefined,
    () => ({ state, events: { dispatch: async (event: object) => void events.push(event) } as unknown as EventDispatcher }),
  );
  const reset = (user: object) => newPassword.store(users, 1, hash, 'reset', user as never);
  return { reset, events, logged, revokedCount: () => revoked, rollbacks: () => rollbacks, newPassword, users, ended };
}

describe('NewPassword and the sign-ins of the account', () => {
  it('a reset ends every sign-in of the user, tokens with them', async () => {
    const { reset, ended } = setup({ state: source([]) });
    await reset({ id: 1, email_verified_at: new Date() });
    expect(ended).toEqual([{ op: 'endAll', args: [1, undefined] }]);
  });

  it('a change keeps the sign-in it is made in, without its token, and ends the others', async () => {
    const { newPassword, users, ended } = setup({ state: source([]) });
    await newPassword.store(users, 1, hash, 'change', undefined, 'old-session-key-of-the-account-0123456789', 'A'.repeat(22));
    expect(ended).toEqual([
      { op: 'endAll', args: [1, 'A'.repeat(22)] },
      { op: 'dropToken', args: [1, 'A'.repeat(22)] },
    ]);
  });

  it('a change without a sign-in of its own ends all of them', async () => {
    const { newPassword, users, ended } = setup({ state: source([]) });
    await newPassword.store(users, 1, hash, 'change');
    expect(ended).toEqual([{ op: 'endAll', args: [1, undefined] }]);
  });

  it('refuses a sign-in store that lacks a method, with its code, before the hash is written', async () => {
    const { users, rollbacks } = setup({ state: source([]) });
    const incomplete = new NewPassword(() => ({}) as never, () => ({ transaction: async (run: () => Promise<unknown>) => run() }) as never, {} as never, {} as never, () => ({ dropToken: async () => {} }) as never);
    await expect(incomplete.store(users, 1, hash, 'reset')).rejects.toThrow(/^\[marmeon:A6\] NewPassword needs SignInStore\.endAll\(\)/);
    expect(users.rows.get(1)?.hash, 'not written').toBe('old');
    expect(rollbacks()).toBe(0);
  });
});

describe('NewPassword over a provider that does not say whether it wrote', () => {
  it('refuses it with its code, and writes nothing more', async () => {
    const { newPassword } = setup({ state: source([]) });
    const silent = { findById: async () => undefined, updatePasswordHash: async () => undefined } as unknown as UserProvider;
    await expect(newPassword.store(silent, 1, hash, 'change')).rejects.toThrow(/^\[marmeon:A5\] NewPassword: UserProvider\.updatePasswordHash/);
  });
});

describe('NewPassword over a provider that refuses a write without expected', () => {
  const refusing = { findById: async () => undefined, updatePasswordHash: async () => false } as unknown as UserProvider;

  it('throws A5 inside the transaction, so the revoked API tokens come back', async () => {
    const { newPassword, revokedCount, rollbacks } = setup({ state: source([]), revokeTokensOnPasswordChange: true });
    await expect(newPassword.store(refusing, 1, hash, 'change')).rejects.toThrow(/^\[marmeon:A5\] NewPassword: UserProvider\.updatePasswordHash\(id, hash\) answered false without expected/);
    expect(revokedCount(), 'the tokens were revoked inside the transaction').toBe(1);
    expect(rollbacks(), 'and it rolled back').toBe(1);
  });

  it('fires no event for a reset that wrote nothing', async () => {
    const { newPassword, events } = setup({ state: source(['totp']) });
    await expect(newPassword.store(refusing, 1, hash, 'reset', { id: 1, email_verified_at: null } as never)).rejects.toThrow(/\[marmeon:A5\]/);
    expect(events).toEqual([]);
  });
});

describe('NewPassword and the session key', () => {
  it('stores the hash with a new key, and returns that key', async () => {
    const { newPassword, users } = setup({ state: source([]) });
    const first = await newPassword.store(users, 1, hash, 'change');
    expect(first.sessionKey).toMatch(/^[\w-]{43}$/);
    expect(users.rows.get(1)).toMatchObject({ hash, key: first.sessionKey });
    expect((await newPassword.store(users, 1, hash, 'reset')).sessionKey, 'a key for every password').not.toBe(first.sessionKey);
  });

  it('gives an account that had no key one', async () => {
    const { newPassword, users } = setup({ state: source([]) });
    users.add({ id: 2, name: 'Bob', email: 'bob@example.com' }, null, null);
    const { sessionKey } = await newPassword.store(users, 2, hash, 'change');
    expect(users.rows.get(2)?.key).toBe(sessionKey);
  });

  it('throws A5 inside the transaction when the provider ignores sessionKey, so nothing stands', async () => {
    const { newPassword, users, revokedCount, rollbacks } = setup({ state: source([]), revokeTokensOnPasswordChange: true });
    users.updatePasswordHash = async (id, newHash) => {
      users.rows.get(id)!.hash = newHash; // writes the hash, drops the key
      return true;
    };
    await expect(newPassword.store(users, 1, hash, 'change')).rejects.toThrow(/^\[marmeon:A5\] NewPassword: UserProvider\.updatePasswordHash\(id, hash, \{ sessionKey \}\) must store the session key/);
    expect(revokedCount()).toBe(1);
    expect(rollbacks()).toBe(1);
  });

  it('throws A5 for an account with no key whose provider ignores sessionKey: it would stay without the row lock', async () => {
    const { newPassword, users } = setup({ state: source([]) });
    users.add({ id: 2, name: 'Bob', email: 'bob@example.com' }, null, null);
    users.updatePasswordHash = async () => true;
    await expect(newPassword.store(users, 2, hash, 'reset')).rejects.toThrow(/\[marmeon:A5\]/);
  });

  it('treats another key than the one written as a later ending, not as a broken provider: a change loses its claim, a reset stands', async () => {
    const { newPassword, users, rollbacks } = setup({ state: source([]) });
    const write = users.updatePasswordHash.bind(users);
    users.updatePasswordHash = async (id, newHash, options) => {
      const wrote = await write(id, newHash, options);
      users.rows.get(id)!.key = 'a-key-that-is-not-the-one-written-0123456789'; // an ending lands right after the write
      return wrote;
    };
    await expect(newPassword.store(users, 1, hash, 'change', undefined, 'old-session-key-of-the-account-0123456789')).rejects.toBeInstanceOf(AccountClaimLost);
    expect(rollbacks()).toBe(1);
    users.rows.get(1)!.key = 'old-session-key-of-the-account-0123456789'; // the memory provider does not roll back
    await expect(newPassword.store(users, 1, hash, 'reset')).resolves.toMatchObject({ revoked: 0 });
  });

  it('refuses the write of a change over a key that is no longer the one its session read, and writes nothing', async () => {
    const { newPassword, users, rollbacks } = setup({ state: source([]) });
    await expect(newPassword.store(users, 1, hash, 'change', undefined, 'another-key-than-the-stored-one-0123456789')).rejects.toBeInstanceOf(AccountClaimLost);
    expect(users.rows.get(1)).toMatchObject({ hash: 'old', key: 'old-session-key-of-the-account-0123456789' });
    expect(rollbacks()).toBe(1);
    await expect(newPassword.store(users, 1, hash, 'change', undefined, 'old-session-key-of-the-account-0123456789')).resolves.toMatchObject({ sessionKey: expect.any(String) });
  });

  it('compares a change of an account without a key with NULL', async () => {
    const { newPassword, users } = setup({ state: source([]) });
    users.add({ id: 2, name: 'Bob', email: 'bob@example.com' }, null, 'a-key-that-ended-the-sessions-0123456789');
    await expect(newPassword.store(users, 2, hash, 'change', undefined, null)).rejects.toBeInstanceOf(AccountClaimLost);
  });
});

describe('NewPassword after a reset of an unconfirmed address', () => {
  it('removes the factors and revokes the API tokens even with revokeTokensOnPasswordChange=false, and says so in two events', async () => {
    const state = source(['passkey', 'totp']);
    const { reset, events, revokedCount } = setup({ state });
    expect((await reset({ id: 1, email_verified_at: null })).revoked).toBe(1);
    expect(state.removed).toBe(1);
    expect(await state.factors(1)).toEqual([]);
    expect(revokedCount()).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[0]).toBeInstanceOf(PasskeyRemoved);
    expect((events[0] as PasskeyRemoved).via).toBe('reset');
    expect(events[1]).toBeInstanceOf(TwoFactorDisabled);
    expect((events[1] as TwoFactorDisabled).via).toBe('reset');
  });

  it('dispatches the passkey event only when a passkey went', async () => {
    const { reset, events } = setup({ state: source(['totp']) });
    await reset({ id: 1, email_verified_at: null });
    expect(events.map((event) => event.constructor)).toEqual([TwoFactorDisabled]);
  });

  it('dispatches nothing for an account without factors, but still revokes its tokens and clears a pending setup', async () => {
    // `factors()` reports confirmed factors only: an authenticator still being set up is not in it, and must go all the same.
    const state = source([]);
    const { reset, events, revokedCount } = setup({ state });
    await reset({ id: 1, email_verified_at: null });
    expect(state.removed).toBe(1);
    expect(events).toEqual([]);
    expect(revokedCount()).toBe(1);
  });

  it('logs an error and does not say the factors are gone when one survived', async () => {
    const { reset, events, logged } = setup({ state: source(['passkey'], { stubborn: true }) });
    await reset({ id: 1, email_verified_at: null });
    expect(events).toEqual([]);
    expect(logged.filter((entry) => entry.level === 'error')).toHaveLength(1);
  });

  it('removes through combineFactors from every source', async () => {
    const first = source(['totp']);
    const second = source(['passkey']);
    const { reset, events } = setup({ state: combineFactors(first, second) });
    await reset({ id: 1, email_verified_at: null });
    expect([first.removed, second.removed]).toEqual([1, 1]);
    expect(events).toHaveLength(2);
  });
});

describe('NewPassword after a reset it leaves alone', () => {
  it('keeps the factors and the tokens of a confirmed account', async () => {
    const state = source(['passkey']);
    const { reset, events, revokedCount } = setup({ state });
    expect((await reset({ id: 1, email_verified_at: '2026-01-01T00:00:00Z' })).revoked).toBe(0);
    expect(state.removed).toBe(0);
    expect(revokedCount()).toBe(0);
    expect(events).toEqual([]);
  });

  it('keeps everything of a user without the email_verified_at property, and warns once while a source is bound', async () => {
    const state = source(['passkey']);
    const { reset, events, logged } = setup({ state });
    await reset({ id: 1 });
    await reset({ id: 1 });
    expect(state.removed).toBe(0);
    expect(events).toEqual([]);
    expect(logged.filter((entry) => entry.level === 'warn')).toHaveLength(1);
  });

  it('does not warn where no factor source is bound', async () => {
    const { reset, logged } = setup({ state: new NoTwoFactorState() });
    await reset({ id: 1 });
    expect(logged.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  it('removes nothing on a password change, whatever the address', async () => {
    const state = source(['passkey']);
    const { newPassword, users } = setup({ state });
    await newPassword.store(users, 1, hash, 'change', { id: 1, email_verified_at: null } as never);
    expect(state.removed).toBe(0);
  });
});

describe('NewPassword for an address that was confirmed once', () => {
  it('keeps the factors and tokens when a change of address cleared email_verified_at', async () => {
    const state = source(['passkey', 'totp']);
    const { reset, events, revokedCount } = setup({ state });
    await reset({ id: 1, email_verified_at: null, first_verified_at: '2026-01-01T00:00:00Z' });
    expect(state.removed).toBe(0);
    expect(revokedCount()).toBe(0);
    expect(events).toEqual([]);
  });

  it('treats a null first_verified_at as never confirmed', async () => {
    const state = source(['totp']);
    const { reset } = setup({ state });
    await reset({ id: 1, email_verified_at: null, first_verified_at: null });
    expect(state.removed).toBe(1);
  });
});

describe('a TwoFactorState without removeAll', () => {
  it('refuses the reset before the token is spent', async () => {
    const old = { factors: async () => [], enabledSince: async () => undefined } as unknown as TwoFactorState; // a source without removeAll() (a cast)
    const { newPassword } = setup({ state: old });
    let consumed = 0;
    const broker = new PasswordBroker({} as never, { consume: async () => (consumed++, { ok: true }) } as never, {} as never, {} as never, { resetMinutes: 60 } as never, newPassword, NO_LOGIN_LIMITS);
    await expect(broker.reset('a@example.com', 'x', 'pw')).rejects.toThrow(/^\[marmeon:A6\] .*removeAll/);
    expect(consumed).toBe(0);
  });

  it('refuses the reset when a source inside a combination lost its removeAll', async () => {
    const inner = twoFactorState();
    const { newPassword } = setup({ state: combineFactors(twoFactorState(), inner) });
    (inner as unknown as { removeAll: unknown }).removeAll = undefined;
    let consumed = 0;
    const broker = new PasswordBroker({} as never, { consume: async () => (consumed++, { ok: true }) } as never, {} as never, {} as never, { resetMinutes: 60 } as never, newPassword, NO_LOGIN_LIMITS);
    await expect(broker.reset('a@example.com', 'x', 'pw')).rejects.toThrow(/^\[marmeon:A6\] .*removeAll/);
    expect(consumed).toBe(0);
  });

  it('is refused already when the combination is made', () => {
    expect(() => combineFactors({ factors: async () => [], enabledSince: async () => undefined } as never)).toThrow(/^\[marmeon:A6\] combineFactors\(\).*removeAll/);
  });
});

describe('combineFactors().removeAll', () => {
  it('asks every source, and none for an empty combination', async () => {
    const a = source(['totp']);
    const b = source(['passkey']);
    await combineFactors(a, b).removeAll(1);
    expect([a.removed, b.removed]).toEqual([1, 1]);
    await combineFactors().removeAll(1);
  });
});
