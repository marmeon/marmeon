import { ConsoleLogger, inTransaction, SystemClock } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_TABLE, PasswordBroker } from './password-reset.ts';
import { PasswordHasher, type PasswordHash } from './hashing.ts';
import type { RememberTokenStore } from './remember.ts';
import { ACCESS_TOKEN_TABLE, DatabaseAccessTokens, type AccessTokenStore } from './tokens.ts';
import { NewPassword } from './new-password.ts';
import type { AuthUser, UserProvider } from './user.ts';

describe.each(drivers)('password reset on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let tokens: DatabasePasswordResetTokens;
  const rows = () => connections.get<any>().selectFrom(PASSWORD_RESET_TABLE).select(['email', 'token_hash']).execute();

  const hasher = new PasswordHasher({ driver: 'argon2id', argon2: { memory: 1024, time: 1, parallelism: 1 }, scrypt: { cost: 10, blockSize: 8, parallelism: 1 } });
  const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
  let hash: PasswordHash;
  const forgotten: unknown[] = [];
  const events: object[] = [];
  const written: boolean[] = [];
  const users: UserProvider = {
    findById: async () => undefined,
    findForLogin: async (email) => (email === ada.email ? { user: ada, passwordHash: hash } : undefined),
    updatePasswordHash: async (_id, next) => void ((hash = next), written.push(inTransaction())),
  };
  const remember = { forgetUser: async (id: unknown) => void forgotten.push(id) } as unknown as RememberTokenStore;
  const logged: unknown[] = [];
  const logger = Object.assign(new ConsoleLogger(), { info: (message: string, context?: unknown) => void logged.push({ message, context }) });
  const broker = (revokeTokensOnPasswordChange = false, accessTokens: AccessTokenStore = apiTokens) =>
    new PasswordBroker(
      users,
      tokens,
      hasher,
      remember,
      { dispatch: async (event: object) => void events.push(event) } as never,
      { resetExpire: 60, resetThrottle: 60 } as never,
      new NewPassword(() => accessTokens, () => connections, { revokeTokensOnPasswordChange } as never, logger),
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
    hash = await hasher.make('old password');
    await connections.get<any>().deleteFrom(ACCESS_TOKEN_TABLE).execute();
    forgotten.length = 0;
    events.length = 0;
    written.length = 0;
    logged.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('stores one token per e-mail, only as a hash', async () => {
    const value = await tokens.create('ada@example.com', 0);
    expect(value).toMatch(/^[\w-]{43}$/);
    await tokens.create('ada@example.com', 0); // replaces the first
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).not.toBe(value);
    expect(JSON.stringify(await connections.get<any>().selectFrom(PASSWORD_RESET_TABLE).selectAll().execute())).not.toContain(value!);
  });

  it('resets the password with a fresh token, once — then drops the remember-me tokens', async () => {
    const created = await broker().createToken('ada@example.com');
    expect(created).toMatchObject({ user: ada, token: expect.stringMatching(/^[\w-]{43}$/) });
    expect(await broker().reset('ada@example.com', created!.token, 'new password')).toEqual(ada);
    expect(await hasher.verify('new password', hash)).toBe(true);
    expect(forgotten).toEqual([1]);
    expect(events.map((event) => event.constructor.name)).toEqual(['PasswordReset']);
    // Counter-check: the same token a second time
    expect(await broker().reset('ada@example.com', created!.token, 'another')).toBeUndefined();
    expect(await hasher.verify('new password', hash)).toBe(true);
  });

  it('revokes every API token of the user with AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true — in the transaction of the new hash, and says so', async () => {
    const adas = [await apiTokens.create(1, 'cli'), await apiTokens.create(1, 'ci')];
    const alans = await apiTokens.create(2, 'cli');
    const created = (await broker(true).createToken('ada@example.com'))!;
    expect(await broker(true).reset('ada@example.com', created.token, 'new password')).toEqual(ada);
    const valid = await Promise.all(adas.map(async ({ plainText }) => (await apiTokens.find(plainText)) !== undefined));
    expect(valid, `Ada's tokens still valid: ${JSON.stringify(valid)}`).toEqual([false, false]);
    expect(await apiTokens.find(alans.plainText), "another user's token").toBeDefined();
    expect(written, 'the new hash was written outside the transaction').toEqual([true]);
    expect(events).toEqual([expect.objectContaining({ user: ada, revokedTokens: 2 })]);
    expect(logged).toEqual([{ message: expect.stringContaining('API tokens'), context: { user: 1, tokens: 2, via: 'reset' } }]);

    // Without the option, the tokens stay valid.
    const kept = await apiTokens.create(1, 'kept');
    const again = (await tokens.create('ada@example.com', 0))!;
    expect(await broker().reset('ada@example.com', again, 'newer password')).toEqual(ada);
    expect(await apiTokens.find(kept.plainText), 'revoked without the option').toBeDefined();
  });

  it('counter-check: the revocation fails — the transaction rolls back, every token stays valid', async () => {
    const adas = [await apiTokens.create(1, 'cli')];
    const failing: AccessTokenStore = Object.assign(Object.create(apiTokens) as AccessTokenStore, {
      revokeAll: async (userId: number | string) => {
        await apiTokens.revokeAll(userId);
        throw new Error('the revocation failed after its delete');
      },
    });
    const created = (await broker(true).createToken('ada@example.com'))!;
    await expect(broker(true, failing).reset('ada@example.com', created.token, 'new password')).rejects.toThrow('the revocation failed');
    expect(await apiTokens.find(adas[0]!.plainText), 'the delete of the failed transaction was kept').toBeDefined();
    expect(events).toEqual([]);
  });

  it('counter-check: an expired token, another e-mail’s token, a guessed token — all one answer', async () => {
    const created = (await broker().createToken('ada@example.com'))!;
    expect(await broker().reset('alan@example.com', created.token, 'x'.repeat(8))).toBeUndefined(); // another e-mail
    expect(await broker().reset('ada@example.com', 'A'.repeat(43), 'x'.repeat(8))).toBeUndefined(); // guessed
    expect(await broker().reset('ada@example.com', 'not a token', 'x'.repeat(8))).toBeUndefined(); // malformed
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60_000 });
    expect(await broker().reset('ada@example.com', created.token, 'x'.repeat(8))).toBeUndefined(); // expired …
    expect(await rows()).toEqual([]); // … and gone
    expect(await hasher.verify('old password', hash)).toBe(true);
  });

  it('gives unknown e-mails nothing, and throttles new links per e-mail', async () => {
    expect(await broker().createToken('nobody@example.com')).toBeUndefined();
    expect(await broker().createToken('ada@example.com')).toBeDefined();
    expect(await broker().createToken('ada@example.com')).toBeUndefined(); // within 60 s
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect(await broker().createToken('ada@example.com')).toBeDefined();
  });

  it('uses a token only once even when two resets race', async () => {
    const created = (await broker().createToken('ada@example.com'))!;
    const results = await Promise.all([tokens.consume('ada@example.com', created.token, 3600), tokens.consume('ada@example.com', created.token, 3600)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
