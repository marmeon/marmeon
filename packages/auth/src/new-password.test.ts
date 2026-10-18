import type { EventDispatcher, Logger } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { PasswordBroker } from './password-reset.ts';
import { PasskeyRemoved, TwoFactorDisabled } from './events.ts';
import type { PasswordHash } from './hashing.ts';
import { NewPassword } from './new-password.ts';
import type { RememberTokenStore } from './remember.ts';
import { SignInTracker } from './sign-ins.ts';
import type { AccessTokenStore } from './tokens.ts';
import { combineFactors, NoTwoFactorState, type SecondFactor, type TwoFactorState } from './two-factor/state.ts';
import type { UserProvider } from './user.ts';

// What a reset of an account with an unconfirmed address takes away — and what it leaves alone.

const hash = 'hash' as unknown as PasswordHash;

/** A source holding `factors` until `removeAll()`; `stubborn` keeps them, as a source that failed to delete would. */
function source(initial: readonly SecondFactor[], { stubborn = false } = {}) {
  let held = [...initial];
  const state: TwoFactorState & { removed: number } = {
    removed: 0,
    factors: async () => held,
    enabledSince: async () => undefined,
    removeAll: async () => {
      state.removed++;
      if (!stubborn) held = [];
    },
  };
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
  const users = { updatePasswordHash: async () => true } as unknown as UserProvider;
  const remember = { forgetUser: async () => {} } as unknown as RememberTokenStore;
  const newPassword = new NewPassword(
    () => tokens,
    () => connections,
    { revokeTokensOnPasswordChange } as never,
    logger,
    new SignInTracker(undefined),
    undefined,
    () => ({ state, events: { dispatch: async (event: object) => void events.push(event) } as unknown as EventDispatcher }),
  );
  const reset = (user: object) => newPassword.store(users, remember, 1, hash, 'reset', user as never);
  return { reset, events, logged, revokedCount: () => revoked, rollbacks: () => rollbacks, newPassword, users, remember };
}

describe('NewPassword over a provider that does not say whether it wrote', () => {
  it('refuses it with its code, and writes nothing more', async () => {
    const { newPassword, remember } = setup({ state: source([]) });
    const silent = { updatePasswordHash: async () => undefined } as unknown as UserProvider;
    await expect(newPassword.store(silent, remember, 1, hash, 'change')).rejects.toThrow(/^\[marmeon:A5\] NewPassword: UserProvider\.updatePasswordHash/);
  });
});

describe('NewPassword over a provider that refuses a write without expected', () => {
  const refusing = { updatePasswordHash: async () => false } as unknown as UserProvider;

  it('throws A5 inside the transaction, so the revoked API tokens come back', async () => {
    const { newPassword, remember, revokedCount, rollbacks } = setup({ state: source([]), revokeTokensOnPasswordChange: true });
    await expect(newPassword.store(refusing, remember, 1, hash, 'change')).rejects.toThrow(/^\[marmeon:A5\] NewPassword: UserProvider\.updatePasswordHash\(id, hash\) answered false without expected/);
    expect(revokedCount(), 'the tokens were revoked inside the transaction').toBe(1);
    expect(rollbacks(), 'and it rolled back').toBe(1);
  });

  it('fires no event for a reset that wrote nothing', async () => {
    const { newPassword, remember, events } = setup({ state: source(['totp']) });
    await expect(newPassword.store(refusing, remember, 1, hash, 'reset', { id: 1, email_verified_at: null } as never)).rejects.toThrow(/\[marmeon:A5\]/);
    expect(events).toEqual([]);
  });
});

describe('NewPassword after a reset of an unconfirmed address', () => {
  it('removes the factors and revokes the API tokens even with revokeTokensOnPasswordChange=false, and says so in two events', async () => {
    const state = source(['passkey', 'totp']);
    const { reset, events, revokedCount } = setup({ state });
    expect(await reset({ id: 1, email_verified_at: null })).toBe(1);
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
    expect(await reset({ id: 1, email_verified_at: '2026-01-01T00:00:00Z' })).toBe(0);
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
    const { newPassword, users, remember } = setup({ state });
    await newPassword.store(users, remember, 1, hash, 'change', { id: 1, email_verified_at: null } as never);
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
    const old = { factors: async () => [], enabledSince: async () => undefined } as unknown as TwoFactorState;
    const { newPassword } = setup({ state: old });
    let consumed = 0;
    const broker = new PasswordBroker({} as never, { consume: async () => (consumed++, { ok: true }) } as never, {} as never, {} as never, {} as never, { resetExpire: 60 } as never, newPassword);
    await expect(broker.reset('a@example.com', 'x', 'pw')).rejects.toThrow('removeAll');
    expect(consumed).toBe(0);
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
