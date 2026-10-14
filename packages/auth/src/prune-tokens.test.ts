import { TestClock } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_TABLE } from './password-reset.ts';
import { PruneTokensCommand } from './prune-tokens.ts';
import { DatabaseRememberTokens, REMEMBER_TABLE } from './remember.ts';
import { ACCESS_TOKEN_TABLE, DatabaseAccessTokens } from './tokens.ts';

describe.each(drivers)('auth:prune-tokens on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
  });
  afterAll(() => close());

  it('deletes expired reset, remember-me and API tokens — every valid one stays', async () => {
    const clock = new TestClock();
    clock.freeze(Date.parse('2026-10-05T10:00:00Z'));
    const resets = new DatabasePasswordResetTokens(connections, clock);
    const remember = new DatabaseRememberTokens(connections, clock);
    const access = new DatabaseAccessTokens(connections, { tokenPrefix: 'marmeon_' } as never, clock);
    const config = { resetExpire: 60, rememberDays: 30 } as never;

    // Two hours ago: a reset token (expired after 60 minutes), a remember-me token for one hour, API tokens for one hour.
    clock.travel({ hours: -2 });
    await resets.create('old@example.com', 0);
    const oldCookie = await remember.create(1, new Date(clock.now() + 3_600_000));
    const expired = await access.create(1, 'expired an hour ago', { expiresIn: '1h' });
    const justExpired = await access.create(1, 'expired a minute ago', { expiresIn: '119m' });
    clock.travel({ hours: 2 });
    // Valid now: a fresh reset token, a remember-me token for 30 days, API tokens with and without expiry.
    const fresh = await resets.create('fresh@example.com', 0);
    const freshToken = fresh.ok ? fresh.value : '';
    const cookie = await remember.create(2, new Date(clock.now() + 30 * 86_400_000));
    const valid = await access.create(2, 'valid', { expiresIn: '1h' });
    const forever = await access.create(2, 'no expiry');

    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
    const prune = (hours?: string) =>
      new PruneTokensCommand(resets, remember, access, config).handle({ args: [], options: hours === undefined ? {} : { hours }, output, root: '/', spawn: async () => 0 } as never);

    // With --hours=1: only API tokens expired more than an hour ago.
    expect(await prune('1')).toBe(0);
    expect(lines.pop()).toBe('Pruned 1 password reset token, 1 remember-me token and 1 API token.');
    expect(await prune()).toBe(0);
    expect(lines.pop()).toBe('Pruned 0 password reset tokens, 0 remember-me tokens and 1 API token.');

    const db = connections.get<any>();
    expect((await db.selectFrom(PASSWORD_RESET_TABLE).select('email').execute()).map((row: { email: string }) => row.email)).toEqual(['fresh@example.com']);
    expect((await db.selectFrom(REMEMBER_TABLE).select('user_id').execute()).map((row: { user_id: number }) => Number(row.user_id))).toEqual([2]);
    expect((await db.selectFrom(ACCESS_TOKEN_TABLE).select('name').orderBy('id').execute()).map((row: { name: string }) => row.name)).toEqual(['valid', 'no expiry']);
    // The survivors still work; the pruned ones are gone for good.
    expect((await resets.consume('fresh@example.com', freshToken, 3600)).ok).toBe(true);
    expect(await remember.consume(cookie)).toMatchObject({ ok: true, value: { userId: 2 } });
    expect(await remember.consume(oldCookie)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(await access.find(valid.plainText)).toBeDefined();
    expect(await access.find(forever.plainText)).toBeDefined();
    expect(await access.find(expired.plainText)).toBeUndefined();
    expect(await access.find(justExpired.plainText)).toBeUndefined();

    expect(await prune('-1')).toBe(1);
    expect(lines.pop()).toMatch(/^✗ --hours must be a number ≥ 0/);
  });

  it('deletes every remember-me token when AUTH_REMEMBER_DAYS is 0 — valid ones too', async () => {
    const clock = new TestClock();
    clock.freeze(Date.parse('2026-10-05T10:00:00Z'));
    const remember = new DatabaseRememberTokens(connections, clock);
    await remember.create(1, new Date(clock.now() + 86_400_000));
    clock.travel({ minutes: 1 });
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
    const command = new PruneTokensCommand(new DatabasePasswordResetTokens(connections, clock), remember, new DatabaseAccessTokens(connections, { tokenPrefix: 'marmeon_' } as never, clock), { resetExpire: 60, rememberDays: 0 } as never);
    await command.handle({ args: [], options: {}, output, root: '/', spawn: async () => 0 } as never);
    expect(lines.pop()).toMatch(/ remember-me tokens?/);
    expect(await connections.get<any>().selectFrom(REMEMBER_TABLE).select('id').execute()).toEqual([]);
  });

});
