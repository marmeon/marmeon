import { hostname, userInfo } from 'node:os';
import { environment, type Logger } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import type { Connections } from '@marmeon/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratedConnections } from './__fixtures__/databases.ts';
import { AccountSessions } from './account-sessions.ts';
import { EndAllSessionsCommand } from './end-all-sessions.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_TABLE } from './password-reset.ts';
import { DatabaseRememberTokens, REMEMBER_TABLE } from './remember.ts';
import { ACCESS_TOKEN_TABLE, DatabaseAccessTokens } from './tokens.ts';
import { AuthServiceProvider, type AuthUser } from './index.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

class Users extends MemoryUsers<AuthUser> {
  constructor() {
    super();
    this.add(ada);
  }
  /** The session key of the one account. */
  get key(): string | null {
    return this.rows.get(ada.id)!.key;
  }
}

describe('auth:end-all-sessions', () => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ connections, close } = await migratedConnections('sqlite'));
  });
  afterAll(() => close());

  async function setup() {
    const db = connections.get<any>();
    for (const table of [REMEMBER_TABLE, PASSWORD_RESET_TABLE, ACCESS_TOKEN_TABLE]) await db.deleteFrom(table).execute();
    const clock = new TestClock();
    const users = new Users();
    const remember = new DatabaseRememberTokens(connections, clock);
    const resets = new DatabasePasswordResetTokens(connections, clock);
    const access = new DatabaseAccessTokens(connections, { tokenPrefix: 'marmeon_' } as never, clock);
    await remember.create(1, new Date(clock.now() + 3_600_000), 'fingerprint');
    await resets.create('ada@example.com', 0);
    const token = await access.create(1, 'ci');
    const accounts = new AccountSessions(users, remember, undefined, undefined, undefined, clock, () => resets, () => access);
    const lines: string[] = [];
    const output = { line: (line: string) => lines.push(line), success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
    const info = vi.fn();
    const run = (options: Record<string, boolean>, target: Pick<AccountSessions, 'endEveryone'> = accounts, args: string[] = []) =>
      new EndAllSessionsCommand(target as AccountSessions, { info } as unknown as Logger).handle({ args, options, output, root: '/', spawn: async () => 0 } as never);
    const rows = async (table: string) => (await db.selectFrom(table).selectAll().execute()).length as number;
    return { users, run, lines, rows, access, token, info };
  }

  it('changes nothing without --force, and says what it would end', async () => {
    const { users, run, lines, rows } = await setup();
    expect(await run({})).toBe(1);
    expect(lines[0]).toBe(`Environment: ${environment.describe()}`);
    expect(lines[1]).toContain('pass --force');
    for (const word of ['remember-me', '--keep-api-tokens', '--keep-reset-tokens', 'Passkeys']) expect(lines[1]).toContain(word);
    expect(users.key).toBeNull();
    expect(await rows(REMEMBER_TABLE)).toBe(1);
  });

  it('ends every session with --force, revokes the API and reset tokens, and says what it did not touch', async () => {
    const { users, run, lines, rows, access, token, info } = await setup();
    expect(await run({ force: true })).toBe(0);
    expect(users.key).toMatch(/^[\w-]{43}$/);
    expect(await rows(REMEMBER_TABLE)).toBe(0);
    expect(await rows(PASSWORD_RESET_TABLE)).toBe(0);
    expect(await access.find(token.plainText)).toBeUndefined();
    expect(lines).toEqual([
      `Environment: ${environment.describe()}`,
      `Ended every session of 1 account: 1 remember-me token and 0 sign-ins deleted, 1 password-reset token deleted, 1 API token revoked. Sessions of every driver end at their next request (environment: ${environment.describe()}).`,
      expect.stringMatching(/^Not touched: passkeys, second factors .*PasskeyRegistered, TwoFactorEnabled, RecoveryCodesGenerated.*auth:reset-two-factor/),
    ]);
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ operator: userInfo().username, host: hostname(), accounts: 1, rememberTokens: 1 }));
  });

  it('keeps the tokens it is told to keep, and names them', async () => {
    const { run, lines, rows, access, token } = await setup();
    expect(await run({ force: true, 'keep-api-tokens': true })).toBe(0);
    expect(await access.find(token.plainText), 'kept').toBeDefined();
    expect(await rows(PASSWORD_RESET_TABLE)).toBe(0);
    expect(lines[1]).toContain('1 password-reset token deleted');
    expect(lines[1]).not.toContain('API token');
    expect(lines[2]).toBe('Kept as asked: API tokens.');

    expect(await run({ force: true, 'keep-api-tokens': true, 'keep-reset-tokens': true })).toBe(0);
    expect(lines.at(-2)).toBe('Kept as asked: API tokens and password-reset tokens.');
  });

  it('refuses --api-tokens and --reset-tokens, which are the default now, and ends nothing', async () => {
    const { users, run, lines, rows, access, token } = await setup();
    for (const [flag, kept] of [['api-tokens', 'keep-api-tokens'], ['reset-tokens', 'keep-reset-tokens']] as const) {
      lines.length = 0;
      expect(await run({ force: true, [flag]: true })).toBe(1);
      expect(lines).toEqual([expect.stringContaining(`--${flag} no longer exists`)]);
      expect(lines[0]).toContain(`--${kept}`);
    }
    expect(users.key).toBeNull();
    expect(await rows(REMEMBER_TABLE)).toBe(1);
    expect(await rows(PASSWORD_RESET_TABLE)).toBe(1);
    expect(await access.find(token.plainText)).toBeDefined();
  });

  it('takes no arguments: a mistyped per-account call changes nothing', async () => {
    const { users, run, lines, rows } = await setup();
    expect(await run({ force: true }, undefined, ['alice@example.com'])).toBe(1);
    expect(lines).toEqual(['✗ auth:end-all-sessions takes no arguments (got "alice@example.com"). To sign out one account, use auth:end-sessions <email> --force.']);
    expect(users.key).toBeNull();
    expect(await rows(REMEMBER_TABLE)).toBe(1);
  });

  it('is registered by the auth provider', () => {
    expect(AuthServiceProvider.commands).toContain(EndAllSessionsCommand);
  });

  it('passes the --keep options through', async () => {
    const endEveryone = vi.fn(async () => ({ accounts: 0, rememberTokens: 0, resetTokens: 0, accessTokens: 0, signIns: 0 }));
    const { run } = await setup();
    await run({ force: true }, { endEveryone });
    await run({ force: true, 'keep-api-tokens': true }, { endEveryone });
    await run({ force: true, 'keep-reset-tokens': true }, { endEveryone });
    expect(endEveryone.mock.calls).toEqual([
      [{ accessTokens: true, resetTokens: true }],
      [{ accessTokens: false, resetTokens: true }],
      [{ accessTokens: true, resetTokens: false }],
    ]);
  });

  it('refuses before changing anything when an API-token store cannot revoke every token', async () => {
    const { users, run, lines, rows } = await setup();
    const remember = new DatabaseRememberTokens(connections, new TestClock());
    const stubborn = new AccountSessions(new Users(), remember, undefined, undefined, undefined, undefined, () => ({ forgetEveryone: async () => 0 }) as never, () => ({}) as never);
    expect(await run({ force: true }, stubborn)).toBe(1);
    expect(lines[1]).toContain('AccessTokenStore.revokeEveryone()');
    expect(lines[1]).toContain('--keep-api-tokens');
    expect(users.key).toBeNull();
    expect(await rows(REMEMBER_TABLE)).toBe(1);
  });

  it('prints the thrown state message and exits non-zero when it fails', async () => {
    const { run, lines } = await setup();
    const message = 'AccountSessions.endEveryone() failed at "session keys" (nothing was changed yet; the keys are NOT rotated) — run it again.';
    const endEveryone = vi.fn(async () => {
      throw new Error(message);
    });
    expect(await run({ force: true }, { endEveryone })).toBe(1);
    expect(lines.at(-1)).toBe(`✗ ${message}`);
  });

  it('refuses before changing anything when the provider cannot write every key', async () => {
    const { run, lines, rows } = await setup();
    const remember = new DatabaseRememberTokens(connections, new TestClock());
    const keyless = new AccountSessions({ ...new Users(), findById: async () => undefined } as never, remember, undefined);
    // An object spread drops the prototype method, so the provider has no updateEverySessionKey().
    expect(await run({ force: true }, keyless)).toBe(1);
    expect(lines[1]).toContain('updateEverySessionKey');
    expect(await rows(REMEMBER_TABLE)).toBe(1);
  });
});
