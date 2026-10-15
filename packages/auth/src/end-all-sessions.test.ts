import { hostname, userInfo } from 'node:os';
import { environment, type Logger, TestClock } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratedConnections } from './__fixtures__/databases.ts';
import { AccountSessions } from './account-sessions.ts';
import { EndAllSessionsCommand } from './end-all-sessions.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_TABLE } from './password-reset.ts';
import { DatabaseRememberTokens, REMEMBER_TABLE } from './remember.ts';
import { ACCESS_TOKEN_TABLE, DatabaseAccessTokens } from './tokens.ts';
import { AuthServiceProvider, type AuthUser, type Credentials, type UserProvider } from './index.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

class Users implements UserProvider {
  key: string | null = null;
  async findById(): Promise<Credentials | undefined> {
    return { user: ada, passwordHash: null, sessionKey: this.key };
  }
  async findForLogin(): Promise<Credentials | undefined> {
    return undefined;
  }
  async updatePasswordHash(): Promise<void> {}
  async updateEverySessionKey(key: string) {
    this.key = key;
    return { accounts: 1, sampleId: ada.id };
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
    for (const word of ['remember-me', '--api-tokens', '--reset-tokens']) expect(lines[1]).toContain(word);
    expect(users.key).toBeNull();
    expect(await rows(REMEMBER_TABLE)).toBe(1);
  });

  it('ends every session with --force, keeps the API and reset tokens, and prints the counts', async () => {
    const { users, run, lines, rows, access, token, info } = await setup();
    expect(await run({ force: true })).toBe(0);
    expect(users.key).toMatch(/^[\w-]{43}$/);
    expect(await rows(REMEMBER_TABLE)).toBe(0);
    expect(await rows(PASSWORD_RESET_TABLE)).toBe(1);
    expect(await access.find(token.plainText)).toBeDefined();
    expect(lines).toEqual([
      `Environment: ${environment.describe()}`,
      `Ended every session of 1 account: 1 remember-me token and 0 sign-ins deleted. Sessions of every driver end at their next request (environment: ${environment.describe()}).`,
    ]);
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ operator: userInfo().username, host: hostname(), accounts: 1, rememberTokens: 1 }));
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

  it('passes --api-tokens and --reset-tokens through', async () => {
    const { run, lines, rows, access, token } = await setup();
    expect(await run({ force: true, 'api-tokens': true, 'reset-tokens': true })).toBe(0);
    expect(await rows(PASSWORD_RESET_TABLE)).toBe(0);
    expect(await access.find(token.plainText)).toBeUndefined();
    expect(lines[1]).toContain('1 password-reset token deleted, 1 API token revoked');

    const endEveryone = vi.fn(async () => ({ accounts: 0, rememberTokens: 0, resetTokens: 0, accessTokens: 0, signIns: 0 }));
    await run({ force: true }, { endEveryone });
    await run({ force: true, 'api-tokens': true }, { endEveryone });
    expect(endEveryone.mock.calls).toEqual([[{ accessTokens: false, resetTokens: false }], [{ accessTokens: true, resetTokens: false }]]);
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
