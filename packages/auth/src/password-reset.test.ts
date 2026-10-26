import { ConsoleLogger, err, inTransaction, resolveConfig, SystemClock, type Result } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { secret, type Connections } from '@marmeon/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_TABLE, PasswordBroker, type PasswordResetTokenTable } from './password-reset.ts';
import { AuthConfig } from './config.ts';
import { PasswordHasher, type PasswordHash } from './hashing.ts';
import { ACCESS_TOKEN_TABLE, DatabaseAccessTokens, type AccessTokenStore } from './tokens.ts';
import { NewPassword } from './new-password.ts';
import { NO_LOGIN_LIMITS } from './test-helpers/login-limits.ts';
import { signInStore } from './test-helpers/stores.ts';
import type { AuthUser, AuthUserId, UserProvider } from './user.ts';

function must<T>(result: Result<T, { readonly kind: string }>): T {
  if (!result.ok) throw new Error('expected an ok result');
  return result.value;
}

describe.each(drivers)('password reset on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let tokens: DatabasePasswordResetTokens;
  const rows = () => connections.get<{ [PASSWORD_RESET_TABLE]: PasswordResetTokenTable }>().selectFrom(PASSWORD_RESET_TABLE).select((eb) => ['email', secret(eb, 'token_hash')]).execute();

  const hasher = new PasswordHasher({ driver: 'argon2id', argon2: { memory: 1024, time: 1, parallelism: 1 }, scrypt: { cost: 10, blockSize: 8, parallelism: 1 } });
  const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
  let hash: PasswordHash;
  const forgotten: unknown[] = [];
  const events: object[] = [];
  const written: boolean[] = [];
  const cleared: (number | string)[] = [];
  let accountGone = false;
  let refuseWrites = false;
  const users: UserProvider = {
    findById: async () => undefined,
    findForSignIn: async (email) => (email === ada.email && !accountGone ? { user: ada, passwordHash: hash, sessionKey: null } : undefined),
    updatePasswordHash: async (_id, next) => (refuseWrites ? false : ((hash = next), written.push(inTransaction()), true)),
    updateSessionKey: async () => false,
    updateEverySessionKey: async () => ({ accounts: 0, sampleId: undefined }),
  };
  const signIns = signInStore({ endAll: async (id) => (forgotten.push(id), 0) });
  const logged: unknown[] = [];
  const logger = Object.assign(new ConsoleLogger(), { info: (message: string, context?: unknown) => void logged.push({ message, context }) });
  const broker = (revokeTokensOnPasswordChange = false, accessTokens: AccessTokenStore = apiTokens) =>
    new PasswordBroker(
      users,
      tokens,
      hasher,
      { dispatch: async (event: object) => void events.push(event) } as never,
      { resetMinutes: 60, resetThrottleSeconds: 60 } as never,
      new NewPassword(() => accessTokens, () => connections, { revokeTokensOnPasswordChange } as never, logger, () => signIns),
      { ...NO_LOGIN_LIMITS, clearAccount: async (id: number | string) => void cleared.push(id) } as never,
    );
  let apiTokens: DatabaseAccessTokens;

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
    tokens = new DatabasePasswordResetTokens(connections, new SystemClock());
    apiTokens = new DatabaseAccessTokens(connections, { tokenPrefix: 'marmeon_' } as never, new SystemClock());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<any>().deleteFrom(PASSWORD_RESET_TABLE).execute();
    accountGone = false;
    refuseWrites = false;
    hash = await hasher.make('old password');
    await connections.get<any>().deleteFrom(ACCESS_TOKEN_TABLE).execute();
    forgotten.length = 0;
    events.length = 0;
    written.length = 0;
    cleared.length = 0;
    logged.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('stores one token per e-mail, only as a hash', async () => {
    const created = await tokens.create('ada@example.com', 0);
    const value = created.ok ? created.value : '';
    expect(value).toMatch(/^[\w-]{43}$/);
    await tokens.create('ada@example.com', 0); // replaces the first
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).not.toBe(value);
    expect(JSON.stringify(await connections.get<any>().selectFrom(PASSWORD_RESET_TABLE).selectAll().execute())).not.toContain(value);
  });

  it('resets the password with a fresh token, once — then drops the remember-me tokens', async () => {
    const created = await broker().createToken('ada@example.com');
    expect(created.ok && created.value).toMatchObject({ user: ada, token: expect.stringMatching(/^[\w-]{43}$/) });
    expect((await broker().reset('ada@example.com', created.ok ? created.value.token : '', 'new password')).ok).toBe(true);
    expect(await hasher.verify('new password', hash)).toBe(true);
    expect(forgotten).toEqual([1]);
    expect(cleared, 'the account takes passwords again').toEqual([1]);
    expect(events.map((event) => event.constructor.name)).toEqual(['PasswordReset']);
    // The same token a second time
    expect(await broker().reset('ada@example.com', created.ok ? created.value.token : '', 'another')).toStrictEqual(err({ kind: 'invalid-token' }));
    expect(await hasher.verify('new password', hash)).toBe(true);
  });

  it('keeps the link when the new password cannot be hashed: it throws, and the same link works with a valid password', async () => {
    const created = must(await broker().createToken('ada@example.com'));
    for (const unhashable of ['x'.repeat(5000), 'lone \ud800 surrogate']) {
      await expect(broker().reset('ada@example.com', created.token, unhashable)).rejects.toThrow(/^\[marmeon:A2\]/);
    }
    expect(await rows()).toHaveLength(1);
    expect(await hasher.verify('old password', hash)).toBe(true);
    expect(await broker().reset('ada@example.com', created.token, 'new password')).toMatchObject({ ok: true, value: ada });
    expect(await hasher.verify('new password', hash)).toBe(true);
  });

  it('throws for an unhashable password with an invalid link just as with a valid one, so the error does not tell the link apart', async () => {
    const created = must(await broker().createToken('ada@example.com'));
    const throwing = async (email: string, value: string) => broker().reset(email, value, 'x'.repeat(5000)).then(() => 'resolved', (error: Error) => error.message);
    const valid = await throwing('ada@example.com', created.token);
    expect(valid).toMatch(/^\[marmeon:A2\]/);
    expect(await throwing('ada@example.com', 'a-wrong-token')).toBe(valid);
    expect(await throwing('nobody@example.com', created.token)).toBe(valid);
  });

  it('is no success when the provider writes nothing: it throws A5 and fires no event', async () => {
    const before = hash;
    const created = must(await broker().createToken('ada@example.com'));
    refuseWrites = true;
    await expect(broker().reset('ada@example.com', created.token, 'new password')).rejects.toThrow(/^\[marmeon:A5\] PasswordBroker|^\[marmeon:A5\] NewPassword/);
    expect(hash).toBe(before);
    expect(events.map((event) => event.constructor.name)).not.toContain('PasswordReset');
  });

  it('keeps the API tokens when the provider writes nothing: the revocation rolls back with the refused write', async () => {
    const token = await apiTokens.create(1, 'cli', { abilities: ['*'], expiresIn: null });
    const created = must(await broker(true).createToken('ada@example.com'));
    refuseWrites = true;
    await expect(broker(true).reset('ada@example.com', created.token, 'new password')).rejects.toThrow(/^\[marmeon:A5\] NewPassword/);
    expect(await apiTokens.find(token.plainText), 'the token is still valid').toBeDefined();
    expect(events.map((event) => event.constructor.name)).not.toContain('PasswordReset');
  });

  it('revokes every API token of the user with AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true — in the transaction of the new hash, and says so', async () => {
    const adas = [await apiTokens.create(1, 'cli', { abilities: ['*'], expiresIn: null }), await apiTokens.create(1, 'ci', { abilities: ['*'], expiresIn: null })];
    const alans = await apiTokens.create(2, 'cli', { abilities: ['*'], expiresIn: null });
    const created = must(await broker(true).createToken('ada@example.com'));
    expect(await broker(true).reset('ada@example.com', created.token, 'new password')).toMatchObject({ ok: true, value: ada });
    const valid = await Promise.all(adas.map(async ({ plainText }) => (await apiTokens.find(plainText)) !== undefined));
    expect(valid, `Ada's tokens still valid: ${JSON.stringify(valid)}`).toEqual([false, false]);
    expect(await apiTokens.find(alans.plainText), "another user's token").toBeDefined();
    expect(written, 'the new hash was written outside the transaction').toEqual([true]);
    expect(events).toEqual([expect.objectContaining({ user: ada, revokedTokens: 2 })]);
    expect(logged).toEqual([{ message: expect.stringContaining('API tokens'), context: { user: 1, tokens: 2, via: 'reset' } }]);

    // Without the option, the tokens stay valid.
    const kept = await apiTokens.create(1, 'kept', { abilities: ['*'], expiresIn: null });
    const again = must(await tokens.create('ada@example.com', 0));
    expect(await broker().reset('ada@example.com', again, 'newer password')).toMatchObject({ ok: true, value: ada });
    expect(await apiTokens.find(kept.plainText), 'revoked without the option').toBeDefined();
  });

  it('a failed revocation rolls the transaction back — every token stays valid', async () => {
    const adas = [await apiTokens.create(1, 'cli', { abilities: ['*'], expiresIn: null })];
    const failing: AccessTokenStore = Object.assign(Object.create(apiTokens) as AccessTokenStore, {
      revokeAll: async (userId: AuthUserId) => {
        await apiTokens.revokeAll(userId);
        throw new Error('the revocation failed after its delete');
      },
    });
    const created = must(await broker(true).createToken('ada@example.com'));
    await expect(broker(true, failing).reset('ada@example.com', created.token, 'new password')).rejects.toThrow('the revocation failed');
    expect(await apiTokens.find(adas[0]!.plainText), 'the delete of the failed transaction was kept').toBeDefined();
    expect(events).toEqual([]);
    // This provider keeps its hashes outside the database's transaction: the revocation comes first, so a failed one writes no hash.
    expect(await hasher.verify('old password', hash), 'a new hash next to live tokens').toBe(true);
  });

  it('an expired token, another e-mail’s token, a guessed token, a malformed one — all one answer', async () => {
    const created = must(await broker().createToken('ada@example.com'));
    const invalid = err({ kind: 'invalid-token' });
    const answers = [
      await broker().reset('alan@example.com', created.token, 'x'.repeat(8)), // another e-mail
      await broker().reset('ada@example.com', 'A'.repeat(43), 'x'.repeat(8)), // guessed
      await broker().reset('ada@example.com', 'not a token', 'x'.repeat(8)), // malformed
    ];
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60_000 });
    answers.push(await broker().reset('ada@example.com', created.token, 'x'.repeat(8))); // expired …
    expect(await rows()).toEqual([]); // … and gone
    for (const answer of answers) {
      expect(answer).toStrictEqual(invalid);
      expect(Object.keys((answer as { error: object }).error)).toEqual(['kind']); // no field says which case it was
    }
    expect(await hasher.verify('old password', hash)).toBe(true);
  });

  it('keeps the deletion of an expired token inside a transaction that returns the err', async () => {
    await tokens.create('ada@example.com', 0);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60_000 });
    const answer = await connections.transaction(() => tokens.consume('ada@example.com', 'A'.repeat(43), 3600));
    expect(answer).toStrictEqual(err({ kind: 'invalid-token' }));
    expect(await rows()).toEqual([]);
  });

  it('answers a wrong token without touching the row', async () => {
    await tokens.create('ada@example.com', 0);
    expect(await connections.transaction(() => tokens.consume('ada@example.com', 'A'.repeat(43), 3600))).toStrictEqual(err({ kind: 'invalid-token' }));
    expect(await rows()).toHaveLength(1);
  });

  it('gives an unknown e-mail and a throttled one the same answer, and throttles new links per e-mail', async () => {
    const unavailable = err({ kind: 'unavailable' });
    expect(await broker().createToken('nobody@example.com')).toStrictEqual(unavailable);
    expect((await broker().createToken('ada@example.com')).ok).toBe(true);
    const throttled = await broker().createToken('ada@example.com'); // within 60 s
    expect(throttled).toStrictEqual(unavailable);
    expect(Object.keys((throttled as { error: object }).error)).toEqual(['kind']);
    expect(await tokens.create('ada@example.com', 60)).toStrictEqual(err({ kind: 'throttled' }));
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect((await broker().createToken('ada@example.com')).ok).toBe(true);
  });

  it('keeps the used-up token gone when the account vanished, inside a transaction that returns the err', async () => {
    const created = must(await broker().createToken('ada@example.com'));
    accountGone = true;
    const answer = await connections.transaction(() => broker().reset('ada@example.com', created.token, 'x'.repeat(8)));
    expect(answer).toStrictEqual(err({ kind: 'invalid-token' }));
    expect(await rows()).toEqual([]);
  });

  it('names every error kind', async () => {
    const consumed = await tokens.consume('ada@example.com', 'A'.repeat(43), 3600);
    const reset = await broker().reset('ada@example.com', 'A'.repeat(43), 'x'.repeat(8));
    const asked = await broker().createToken('nobody@example.com');
    await tokens.create('ada@example.com', 0);
    const created = await tokens.create('ada@example.com', 60);
    const seen: string[] = [];
    if (!consumed.ok) {
      switch (consumed.error.kind) {
        case 'invalid-token':
          seen.push('consume');
          break;
        default:
          consumed.error.kind satisfies never;
      }
    }
    if (!reset.ok) {
      switch (reset.error.kind) {
        case 'invalid-token':
          seen.push('reset');
          break;
        default:
          reset.error.kind satisfies never;
      }
    }
    if (!asked.ok) {
      switch (asked.error.kind) {
        case 'unavailable':
          seen.push('createToken');
          break;
        default:
          asked.error.kind satisfies never;
      }
    }
    if (!created.ok) {
      switch (created.error.kind) {
        case 'throttled':
          seen.push('create');
          break;
        default:
          created.error.kind satisfies never;
      }
    }
    expect(seen).toEqual(['consume', 'reset', 'createToken', 'create']);
  });

  it('uses a token only once even when two resets race', async () => {
    const created = must(await broker().createToken('ada@example.com'));
    const results = await Promise.all([tokens.consume('ada@example.com', created.token, 3600), tokens.consume('ada@example.com', created.token, 3600)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('counts AUTH_RESET_MINUTES and AUTH_RESET_THROTTLE_SECONDS in minutes and seconds, from the configuration', async () => {
    const config = (await resolveConfig([AuthConfig], { AUTH_RESET_MINUTES: '1', AUTH_RESET_THROTTLE_SECONDS: '30' })).get(AuthConfig) as AuthConfig;
    const clock = new TestClock();
    clock.freeze(Date.now());
    const timed = new DatabasePasswordResetTokens(connections, clock);
    const timedBroker = new PasswordBroker(users, timed, hasher, { dispatch: async () => {} } as never, config, new NewPassword(() => apiTokens, () => connections, { revokeTokensOnPasswordChange: false } as never, logger, () => signIns), NO_LOGIN_LIMITS as never);

    const fresh = must(await timedBroker.createToken('ada@example.com'));
    clock.travel({ seconds: 29 });
    expect((await timedBroker.createToken('ada@example.com')).ok, '29 s: inside the pause').toBe(false);
    clock.travel({ seconds: 2 });
    const second = must(await timedBroker.createToken('ada@example.com'));
    expect(second.token, '31 s: a new token').not.toBe(fresh.token);

    clock.travel({ seconds: 59 });
    expect((await timedBroker.reset('ada@example.com', second.token, 'new password')).ok, '59 s: accepted').toBe(true);

    const late = must(await timedBroker.createToken('ada@example.com'));
    clock.travel({ seconds: 61 });
    expect(await timedBroker.reset('ada@example.com', late.token, 'newer password'), '61 s: refused').toStrictEqual(err({ kind: 'invalid-token' }));
  });
});
