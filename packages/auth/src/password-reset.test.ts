import type { Connections } from '@bespokecore/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_TABLE, PasswordBroker } from './password-reset.ts';
import { PasswordHasher, type PasswordHash } from './hashing.ts';
import type { RememberTokenStore } from './remember.ts';
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
  const users: UserProvider = {
    findById: async () => undefined,
    findForLogin: async (email) => (email === ada.email ? { user: ada, passwordHash: hash } : undefined),
    updatePasswordHash: async (_id, next) => void (hash = next),
  };
  const remember = { forgetUser: async (id: unknown) => void forgotten.push(id) } as unknown as RememberTokenStore;
  const broker = () =>
    new PasswordBroker(users, tokens, hasher, remember, { dispatch: async (event: object) => void events.push(event) } as never, {
      resetExpire: 60,
      resetThrottle: 60,
    } as never);

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
    tokens = new DatabasePasswordResetTokens(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<any>().deleteFrom(PASSWORD_RESET_TABLE).execute();
    hash = await hasher.make('old password');
    forgotten.length = 0;
    events.length = 0;
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
