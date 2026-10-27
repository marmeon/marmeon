import { ok, type Logger } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import type { Connections } from '@marmeon/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratedConnections } from './__fixtures__/databases.ts';
import { AccountSessions } from './account-sessions.ts';
import { EndSessionsCommand } from './end-sessions.ts';
import { AuthServiceProvider, type AuthUser } from './index.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_TABLE } from './password-reset.ts';
import { DatabaseSignIns, SIGN_INS_TABLE } from './sign-ins.ts';
import { ACCESS_TOKEN_TABLE, DatabaseAccessTokens } from './tokens.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

describe('auth:end-sessions', () => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ connections, close } = await migratedConnections('sqlite'));
  });
  afterAll(() => close());

  async function setup() {
    const db = connections.get<any>();
    for (const table of [SIGN_INS_TABLE, PASSWORD_RESET_TABLE, ACCESS_TOKEN_TABLE]) await db.deleteFrom(table).execute();
    const clock = new TestClock();
    const users = new MemoryUsers<AuthUser>();
    users.add(ada);
    const signIns = new DatabaseSignIns(connections, clock);
    await signIns.issueToken(1, await signIns.create({ userId: 1, userAgent: undefined }), { until: new Date(clock.now() + 3_600_000), fingerprint: 'fingerprint' });
    const resets = new DatabasePasswordResetTokens(connections, clock);
    const access = new DatabaseAccessTokens(connections, { tokenPrefix: 'marmeon_' } as never, clock);
    await resets.create('ada@example.com', 0);
    const token = await access.create(1, 'ci', { abilities: ['*'], expiresIn: null });
    const accounts = new AccountSessions(users, signIns, undefined, undefined, clock, () => resets, () => access);
    const lines: string[] = [];
    const output = { line: (line: string) => lines.push(line), success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
    const info = vi.fn();
    const run = (args: string[], options: Record<string, boolean> = { force: true }, target: Pick<AccountSessions, 'end'> = accounts) =>
      new EndSessionsCommand(users, target as AccountSessions, { info } as unknown as Logger).handle({ args, options, output, root: '/', spawn: async () => 0 } as never);
    const key = () => users.rows.get(1)!.key;
    const signInRows = async () => (await db.selectFrom(SIGN_INS_TABLE).selectAll().execute()).length as number;
    const resetRows = async () => (await db.selectFrom(PASSWORD_RESET_TABLE).selectAll().execute()).length as number;
    return { users, run, lines, key, signInRows, info, accounts, access, token, resets, resetRows };
  }

  it('ends the sessions of the account the identifier names, and logs who it was', async () => {
    const { run, lines, key, signInRows, info } = await setup();
    expect(await run([' ada@example.com '])).toBe(0);
    expect(key()).toMatch(/^[\w-]{43}$/);
    expect(await signInRows()).toBe(0);
    expect(lines).toEqual([expect.stringContaining('of ada@example.com;'), 'Kept: second factors, passkeys']);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('every session'), { userId: 1 });
  });

  it('revokes the API tokens and deletes the reset link, and says what it kept', async () => {
    const { run, lines, access, token, resetRows } = await setup();
    expect(await access.find(token.plainText)).toBeDefined();
    expect(await resetRows()).toBe(1);
    expect(await run(['ada@example.com'])).toBe(0);
    expect(await access.find(token.plainText), 'token revoked').toBeUndefined();
    expect(await resetRows(), 'reset link deleted').toBe(0);
    expect(lines).toEqual([expect.stringContaining('Revoked 1 API tokens and deleted the password-reset link, if there was one'), 'Kept: second factors, passkeys']);
  });

  it('--keep-api-tokens leaves the token valid and says so', async () => {
    const { run, lines, access, token, resetRows } = await setup();
    expect(await run(['ada@example.com'], { force: true, 'keep-api-tokens': true })).toBe(0);
    expect(await access.find(token.plainText), 'token kept').toBeDefined();
    expect(await resetRows(), 'reset link still deleted').toBe(0);
    expect(lines).toEqual([expect.stringContaining('Revoked 0 API tokens'), 'Kept: second factors, passkeys, API tokens']);
  });

  it('end() takes { accessTokens: false } to keep the tokens, reports the counts, and refuses a non-object', async () => {
    const { accounts, access, token } = await setup();
    expect(await accounts.end(1, { accessTokens: false })).toEqual(ok({ removed: 0, accessTokens: 0 }));
    expect(await access.find(token.plainText)).toBeDefined();
    await expect(accounts.end(1, false as never)).rejects.toThrow(TypeError);
    await expect(accounts.end(1, true as never)).rejects.toThrow(/options as an object/);
    expect(await accounts.end(1)).toEqual(ok({ removed: 0, accessTokens: 1 }));
    expect(await access.find(token.plainText)).toBeUndefined();
  });

  it('end() revokes the API tokens before it touches the reset store: a reset store that throws leaves no token', async () => {
    const { access, token, users } = await setup();
    const failing = { forget: async () => Promise.reject(new Error('reset store down')) } as never;
    const accounts = new AccountSessions(users, new DatabaseSignIns(connections, new TestClock()), undefined, undefined, undefined, () => failing, () => access);
    await expect(accounts.end(1)).rejects.toThrow('reset store down');
    expect(await access.find(token.plainText), 'the live credential is gone').toBeUndefined();
  });

  it('end() without an API-token or reset store bound reports zeros', async () => {
    const users = new MemoryUsers<AuthUser>();
    users.add(ada);
    const bare = new AccountSessions(users, new DatabaseSignIns(connections, new TestClock()), undefined);
    expect(await bare.end(1)).toEqual(ok({ removed: 0, accessTokens: 0 }));
  });

  it('changes nothing without --force', async () => {
    const { run, lines, key, signInRows } = await setup();
    expect(await run(['ada@example.com'], {})).toBe(1);
    expect(lines[0]).toContain('pass --force');
    expect(key()).toBeNull();
    expect(await signInRows()).toBe(1);
  });

  it('exits 1 for an unknown identifier and refuses none as a wrong call (exit 2), and ends nothing', async () => {
    const { run, lines, key, signInRows } = await setup();
    expect(await run(['nobody@example.com'])).toBe(1);
    await expect(run([])).rejects.toMatchObject({ name: 'CommandArgumentsError', message: 'Usage: marmeon auth:end-sessions <identifier> --force' });
    await expect(run(['   '])).rejects.toMatchObject({ name: 'CommandArgumentsError' });
    expect(lines).toEqual(['✗ No account has the identifier nobody@example.com: the lookup is exact (only trimmed), so type it as it is stored, e.g. nobody@example.com.']);
    expect(key()).toBeNull();
    expect(await signInRows()).toBe(1);
  });

  it('does not find an address typed in capitals, says how to type it, and ends nothing', async () => {
    const { run, lines, key, signInRows } = await setup();
    const end = vi.fn();
    expect(await run(['ADA@Example.com'], { force: true }, { end })).toBe(1);
    expect(lines).toEqual([expect.stringContaining('e.g. ada@example.com')]);
    expect(end).not.toHaveBeenCalled();
    expect(key()).toBeNull();
    expect(await signInRows()).toBe(1);
  });

  it('exits 1 when the account vanished before its sessions ended', async () => {
    const { run, lines } = await setup();
    const end = vi.fn(async () => ({ ok: false, error: { kind: 'missing' } }) as never);
    expect(await run(['ada@example.com'], { force: true }, { end })).toBe(1);
    expect(lines).toEqual(['✗ No account has the identifier ada@example.com: the lookup is exact (only trimmed), so type it as it is stored, e.g. ada@example.com.']);
  });

  it('is registered by the auth provider', () => {
    expect(AuthServiceProvider.commands).toContain(EndSessionsCommand);
  });
});
