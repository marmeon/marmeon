import { Container, inTransaction, SystemClock } from '@marmeon/core';
import { sql, type Connections } from '@marmeon/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { NewPassword } from './new-password.ts';
import { DatabasePasswordResetTokens } from './password-reset.ts';
import { onPasswordReset, sealPasswordResetHooks, type PasswordResetHook } from './reset-hooks.ts';
import { optionsFor, setsOf } from './__fixtures__/table-sets.ts';
import { guardContext } from './test-helpers/guard-context.ts';
import { signInStore } from './test-helpers/stores.ts';
import type { AuthUser, AuthUserId, UserProvider } from './user.ts';
import type { PasswordHash } from './hashing.ts';

describe('claiming a password reset hook', () => {
  const hook: PasswordResetHook = async () => {};

  it('takes a name once per root container, before the boot, on the app container only', () => {
    const root = new Container();
    onPasswordReset(root, 'oauth', hook);
    expect(() => onPasswordReset(root, 'oauth', hook)).toThrow(/claimed already/);
    expect(() => onPasswordReset(root, 'Bad Name', hook)).toThrow(/lower case/);
    expect(() => onPasswordReset(root.createScope(), 'scoped', hook)).toThrow(/request's scope/);
    expect(() => onPasswordReset(root, 'notfn', 'x' as never)).toThrow(/must be a function/);
    sealPasswordResetHooks(root);
    expect(() => onPasswordReset(root, 'late', hook)).toThrow(/after the auth provider booted/);
    // Another root is another claim.
    expect(() => onPasswordReset(new Container(), 'oauth', hook)).not.toThrow();
  });
});

describe.each(drivers)('a password reset runs the claimed hooks in its transaction on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  const own = setsOf('app').own;
  const ada = (verified: unknown): AuthUser => ({ id: 1, name: 'Ada', email: 'ada@example.com', ...(verified === 'unknown' ? {} : { email_verified_at: verified }) }) as never;

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver, undefined, undefined, true));
  });
  afterAll(() => close());

  /** Runs a reset or a change for `user` with `hooks` claimed on the root of the guard (`none`: a guard without a root). */
  async function run(via: 'reset' | 'change', user: AuthUser, hooks: Record<string, PasswordResetHook>, root: 'app' | 'none' = 'app', readBack?: { readonly email_verified_at: unknown }): Promise<unknown> {
    const container = new Container();
    for (const [name, claimed] of Object.entries(hooks)) onPasswordReset(container, name, claimed);
    let key: string | null = null;
    let written = false;
    const users = {
      findById: async () => ({ user: written && readBack !== undefined ? { ...user, ...readBack } : user, passwordHash: null, sessionKey: key }),
      updatePasswordHash: async (_id: unknown, _hash: unknown, options?: { sessionKey?: string }) => ((key = options?.sessionKey ?? null), (written = true), true),
    } as unknown as UserProvider;
    const guard = guardContext({ users, signIns: signInStore({ endAll: async () => 0 }), connections, settings: { revokeTokensOnPasswordChange: false } as never, root: root === 'app' ? container : undefined });
    return new NewPassword(guard)
      .store(users, 1 as AuthUserId, 'hash' as PasswordHash, via, user, via === 'change' ? key : undefined)
      .then(() => 'stored', (error: unknown) => error);
  }

  it('hands a reset the id and whether the address is confirmed, inside the transaction', async () => {
    const seen: unknown[] = [];
    const hook: PasswordResetHook = async (input) => void seen.push({ ...input, inTransaction: inTransaction() });
    expect(await run('reset', ada(null), { one: hook })).toBe('stored');
    expect(await run('reset', ada(new Date()), { one: hook })).toBe('stored');
    expect(seen).toEqual([
      { userId: 1, emailConfirmed: false, inTransaction: true },
      { userId: 1, emailConfirmed: true, inTransaction: true },
    ]);
  });

  it('counts the address as unconfirmed when either the account as found or as read back says so', async () => {
    const seen: boolean[] = [];
    const hook: PasswordResetHook = async ({ emailConfirmed }) => void seen.push(emailConfirmed);
    // The write of the new password itself confirms the address: what the owner never had must not be kept.
    await run('reset', ada(null), { one: hook }, 'app', { email_verified_at: new Date() });
    // Confirmed when found, and unconfirmed when read back.
    await run('reset', ada(new Date()), { one: hook }, 'app', { email_verified_at: null });
    // Confirmed in both views.
    await run('reset', ada(new Date()), { one: hook }, 'app', { email_verified_at: new Date() });
    expect(seen).toEqual([false, false, true]);
  });

  it('counts an account that does not say as unconfirmed', async () => {
    const seen: boolean[] = [];
    await run('reset', ada('unknown'), { one: async ({ emailConfirmed }) => void seen.push(emailConfirmed) });
    expect(seen).toEqual([false]);
  });

  it('does not run for a change of password, nor for a guard that has no root container', async () => {
    let ran = 0;
    const hook: PasswordResetHook = async () => void (ran += 1);
    await run('change', ada(null), { one: hook });
    await run('reset', ada(null), { one: hook }, 'none');
    expect(ran).toBe(0);
  });

  it('rolls the reset back when a hook throws, and what the hooks before it wrote with it', async () => {
    const tokens = new DatabasePasswordResetTokens(connections, new SystemClock(), optionsFor(own).passwordResets);
    const outcome = await run('reset', ada(null), {
      first: async () => {
        await tokens.create('hook@example.com', 0);
      },
      second: async () => {
        throw new Error('hook failed');
      },
    });
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('hook failed');
    const rows = await sql<{ n: number }>`select count(*) as n from ${sql.id(own.passwordResets)} where email = ${'hook@example.com'}`.execute(connections.get());
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });
});
