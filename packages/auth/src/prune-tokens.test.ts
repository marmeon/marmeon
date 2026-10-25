import { resolveConfig } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { sql, type Connections } from '@marmeon/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthConfig } from './config.ts';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { DatabasePasswordResetTokens, PASSWORD_RESET_TABLE } from './password-reset.ts';
import { PruneTokensCommand } from './prune-tokens.ts';
import { DatabaseSignIns, SIGN_INS_TABLE } from './sign-ins.ts';
import { ACCESS_TOKEN_TABLE, DatabaseAccessTokens } from './tokens.ts';

describe.each(drivers)('auth:prune-tokens on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<any>().deleteFrom(SIGN_INS_TABLE).execute();
  });

  /** The user ids of the sign-ins that still hold a remember-me token. */
  const withToken = async () =>
    (await connections.get<any>().selectFrom(SIGN_INS_TABLE).select('user_id').where(sql<boolean>`${sql.ref('remember_selector')} is not null`).execute()).map((row: { user_id: number }) => Number(row.user_id));

  it('deletes expired reset and API tokens and takes expired remember-me tokens off their sign-ins — every valid one stays', async () => {
    const clock = new TestClock();
    clock.freeze(Date.parse('2026-10-05T10:00:00Z'));
    const resets = new DatabasePasswordResetTokens(connections, clock);
    const signIns = new DatabaseSignIns(connections, clock);
    const access = new DatabaseAccessTokens(connections, { tokenPrefix: 'marmeon_' } as never, clock);
    const config = { resetExpire: 60, rememberDays: 30, sessionMaxSeconds: 86_400 } as never;

    // Two hours ago: a reset token (expired after 60 minutes), a remember-me token for one hour, API tokens for one hour.
    clock.travel({ hours: -2 });
    await resets.create('old@example.com', 0);
    const oldCookie = await signIns.issueToken(1, await signIns.create({ userId: 1, userAgent: 'old' }), { until: new Date(clock.now() + 3_600_000), fingerprint: 'fp' });
    const expired = await access.create(1, 'expired an hour ago', { expiresIn: { hours: 1 } });
    const justExpired = await access.create(1, 'expired a minute ago', { expiresIn: { minutes: 119 } });
    clock.travel({ hours: 2 });
    // Valid now: a fresh reset token, a remember-me token for 30 days, API tokens with and without expiry.
    const fresh = await resets.create('fresh@example.com', 0);
    const freshToken = fresh.ok ? fresh.value : '';
    const cookie = await signIns.issueToken(2, await signIns.create({ userId: 2, userAgent: 'fresh' }), { until: new Date(clock.now() + 30 * 86_400_000), fingerprint: 'fp' });
    const valid = await access.create(2, 'valid', { expiresIn: { hours: 1 } });
    const forever = await access.create(2, 'no expiry');

    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
    const prune = (hours?: string) =>
      new PruneTokensCommand(resets, access, config, { lifetime: 120 } as never, signIns).handle({ args: [], options: hours === undefined ? {} : { hours }, output, root: '/', spawn: async () => 0 } as never);

    // With --hours=1: only API tokens expired more than an hour ago. The old sign-in is still within its idle time, so it stays: without its token.
    expect(await prune('1')).toBe(0);
    expect(lines.pop()).toBe('Pruned 1 password reset token, 1 API token and 0 sign-ins.');
    expect(await prune()).toBe(0);
    expect(lines.pop()).toBe('Pruned 0 password reset tokens, 1 API token and 0 sign-ins.');

    const db = connections.get<any>();
    expect((await db.selectFrom(PASSWORD_RESET_TABLE).select('email').execute()).map((row: { email: string }) => row.email)).toEqual(['fresh@example.com']);
    expect(await withToken()).toEqual([2]);
    expect(await db.selectFrom(SIGN_INS_TABLE).select('id').execute(), 'both rows live on').toHaveLength(2);
    expect((await db.selectFrom(ACCESS_TOKEN_TABLE).select('name').orderBy('id').execute()).map((row: { name: string }) => row.name)).toEqual(['valid', 'no expiry']);
    // The survivors still work; the pruned ones are gone for good.
    expect((await resets.consume('fresh@example.com', freshToken, 3600)).ok).toBe(true);
    expect(await signIns.consume(cookie)).toMatchObject({ ok: true, value: { userId: 2 } });
    expect(await signIns.consume(oldCookie)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(await access.find(valid.plainText)).toBeDefined();
    expect(await access.find(forever.plainText)).toBeDefined();
    expect(await access.find(expired.plainText)).toBeUndefined();
    expect(await access.find(justExpired.plainText)).toBeUndefined();

    expect(await prune('-1')).toBe(1);
    expect(lines.pop()).toMatch(/^✗ --hours must be a number ≥ 0/);
  });

  it('takes every remember-me token off when AUTH_REMEMBER_DAYS is 0 — valid ones too — and keeps the sign-in', async () => {
    const clock = new TestClock();
    clock.freeze(Date.parse('2026-10-05T10:00:00Z'));
    const signIns = new DatabaseSignIns(connections, clock);
    const id = await signIns.create({ userId: 1, userAgent: 'laptop' });
    const cookie = await signIns.issueToken(1, id, { until: new Date(clock.now() + 86_400_000), fingerprint: 'fp' });
    clock.travel({ minutes: 1 });
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
    const command = new PruneTokensCommand(new DatabasePasswordResetTokens(connections, clock), new DatabaseAccessTokens(connections, { tokenPrefix: 'marmeon_' } as never, clock), { resetExpire: 60, rememberDays: 0, sessionMaxSeconds: 86_400 } as never, { lifetime: 120 } as never, signIns);
    await command.handle({ args: [], options: {}, output, root: '/', spawn: async () => 0 } as never);
    expect(lines.pop()).toBe('Pruned 0 password reset tokens, 0 API tokens and 0 sign-ins.');
    expect(await withToken()).toEqual([]);
    expect(await signIns.seen(1, id, false), 'the session lives on').toBe(true);
    expect(await signIns.consume(cookie)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });

  it('deletes the sign-ins that are over — and counts them', async () => {
    const clock = new TestClock();
    clock.freeze(Date.parse('2026-10-05T10:00:00Z'));
    const signIns = new DatabaseSignIns(connections, clock);
    await signIns.create({ userId: 1, userAgent: 'old' });
    clock.travel({ hours: 3 }); // past SESSION_LIFETIME_MINUTES (120 minutes) and the write granularity
    const live = await signIns.create({ userId: 1, userAgent: 'live' });
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
    const command = new PruneTokensCommand(
      new DatabasePasswordResetTokens(connections, clock),
      new DatabaseAccessTokens(connections, { tokenPrefix: 'marmeon_' } as never, clock),
      { resetExpire: 60, rememberDays: 30, sessionMaxSeconds: 86_400 } as never,
      { lifetime: 120 } as never,
      signIns,
    );
    await command.handle({ args: [], options: {}, output, root: '/', spawn: async () => 0 } as never);
    expect(lines.pop()).toMatch(/ and 1 sign-in\.$/);
    expect((await connections.get<any>().selectFrom(SIGN_INS_TABLE).select('id').execute()).map((row: { id: string }) => row.id)).toEqual([live]);
  });

  it('counts AUTH_RESET_MINUTES in minutes: a reset token 59 seconds old stays, one 61 seconds old goes', async () => {
    const config = (await resolveConfig([AuthConfig], { AUTH_RESET_MINUTES: '1' })).get(AuthConfig) as AuthConfig;
    const clock = new TestClock();
    clock.freeze(Date.parse('2026-10-05T10:00:00Z'));
    const resets = new DatabasePasswordResetTokens(connections, clock);
    await connections.get<any>().deleteFrom(PASSWORD_RESET_TABLE).execute();
    await resets.create('older@example.com', 0);
    clock.travel({ seconds: 2 });
    await resets.create('younger@example.com', 0);
    clock.travel({ seconds: 59 });
    const signIns = new DatabaseSignIns(connections, clock);
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
    const command = new PruneTokensCommand(resets, new DatabaseAccessTokens(connections, { tokenPrefix: 'marmeon_' } as never, clock), config, { lifetime: 120 } as never, signIns);
    await command.handle({ args: [], options: {}, output, root: '/', spawn: async () => 0 } as never);
    expect(lines.pop()).toMatch(/^Pruned 1 password reset token,/);
    expect((await connections.get<any>().selectFrom(PASSWORD_RESET_TABLE).select('email').execute()).map((row: { email: string }) => row.email)).toEqual(['younger@example.com']);
  });
});
