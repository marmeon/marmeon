import type { Logger } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import type { Connections } from '@marmeon/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratedConnections } from './__fixtures__/databases.ts';
import { AccountSessions } from './account-sessions.ts';
import { EndSessionsCommand } from './end-sessions.ts';
import { AuthServiceProvider, type AuthUser } from './index.ts';
import { DatabaseSignIns, SIGN_INS_TABLE } from './sign-ins.ts';
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
    await db.deleteFrom(SIGN_INS_TABLE).execute();
    const clock = new TestClock();
    const users = new MemoryUsers<AuthUser>();
    users.add(ada);
    const signIns = new DatabaseSignIns(connections, clock);
    await signIns.issueToken(1, await signIns.create({ userId: 1, userAgent: undefined }), { until: new Date(clock.now() + 3_600_000), fingerprint: 'fingerprint' });
    const accounts = new AccountSessions(users, signIns, undefined, undefined, clock);
    const lines: string[] = [];
    const output = { line: (line: string) => lines.push(line), success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
    const info = vi.fn();
    const run = (args: string[], options: Record<string, boolean> = { force: true }, target: Pick<AccountSessions, 'end'> = accounts) =>
      new EndSessionsCommand(users, target as AccountSessions, { info } as unknown as Logger).handle({ args, options, output, root: '/', spawn: async () => 0 } as never);
    const key = () => users.rows.get(1)!.key;
    const signInRows = async () => (await db.selectFrom(SIGN_INS_TABLE).selectAll().execute()).length as number;
    return { run, lines, key, signInRows, info };
  }

  it('ends the sessions of the account the identifier names, and logs who it was', async () => {
    const { run, lines, key, signInRows, info } = await setup();
    expect(await run([' ada@example.com '])).toBe(0);
    expect(key()).toMatch(/^[\w-]{43}$/);
    expect(await signInRows()).toBe(0);
    expect(lines).toEqual([expect.stringContaining('of ada@example.com;')]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('every session'), { userId: 1 });
  });

  it('changes nothing without --force', async () => {
    const { run, lines, key, signInRows } = await setup();
    expect(await run(['ada@example.com'], {})).toBe(1);
    expect(lines[0]).toContain('pass --force');
    expect(key()).toBeNull();
    expect(await signInRows()).toBe(1);
  });

  it('exits 1 for an unknown identifier or none, and ends nothing', async () => {
    const { run, lines, key, signInRows } = await setup();
    expect(await run(['nobody@example.com'])).toBe(1);
    expect(await run([])).toBe(1);
    expect(await run(['   '])).toBe(1);
    expect(lines).toEqual(['✗ No account has the identifier nobody@example.com: the lookup is exact (only trimmed), so type it as it is stored, e.g. nobody@example.com.', '✗ Usage: marmeon auth:end-sessions <identifier> --force', '✗ Usage: marmeon auth:end-sessions <identifier> --force']);
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
