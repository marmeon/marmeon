import { err, SystemClock, type Result } from '@marmeon/core';
import { secret, type Connections } from '@marmeon/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { DatabaseRememberTokens, REMEMBER_TABLE, type RememberedDevice, type RememberTokenError, type RememberTokenTable } from './remember.ts';

describe.each(drivers)('DatabaseRememberTokens on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let tokens: DatabaseRememberTokens;
  const inAMonth = () => new Date(Date.now() + 30 * 86_400_000);
  const issued = (result: Result<RememberedDevice, RememberTokenError>) => (result.ok ? result.value.cookie : undefined);
  const rows = () => connections.get<{ [REMEMBER_TABLE]: RememberTokenTable }>().selectFrom(REMEMBER_TABLE).select((eb) => ['user_id', 'selector', secret(eb, 'validator_hash')]).execute();

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
    tokens = new DatabaseRememberTokens(connections, new SystemClock());
  });
  afterAll(() => close());
  beforeEach(() => connections.get<any>().deleteFrom(REMEMBER_TABLE).execute());
  afterEach(() => vi.useRealTimers());

  it('hands out selector.validator and stores only the selector and a hash of the validator', async () => {
    const cookie = await tokens.create(1, inAMonth());
    expect(cookie).toMatch(/^[\w-]{22}\.[\w-]{43}$/);
    const [selector, validator] = cookie.split('.') as [string, string];
    const [row] = await rows();
    expect(row).toMatchObject({ user_id: 1, selector });
    expect(row!.validator_hash).not.toContain(validator);
    expect(JSON.stringify(await connections.get<any>().selectFrom(REMEMBER_TABLE).selectAll().execute())).not.toContain(validator);
  });

  it('accepts a valid cookie and rotates the validator — the selector stays', async () => {
    const cookie = await tokens.create(1, inAMonth());
    const result = await tokens.consume(cookie);
    expect(result.ok && result.value).toMatchObject({ userId: 1, cookie: expect.stringMatching(/^[\w-]{22}\.[\w-]{43}$/) });
    const rotated = issued(result)!;
    expect(rotated.split('.')[0]).toBe(cookie.split('.')[0]);
    expect(rotated).not.toBe(cookie);
    expect((await tokens.consume(rotated)).ok).toBe(true);
  });

  it('theft: an old validator after the grace period drops every token of the user', async () => {
    const stolen = await tokens.create(1, inAMonth());
    await tokens.create(1, inAMonth()); // another device of the same user
    await tokens.create(2, inAMonth()); // someone else
    const thief = await tokens.consume(stolen); // the thief uses the copied cookie first: rotated
    expect(thief.ok).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect(await tokens.consume(stolen)).toStrictEqual(err({ kind: 'stolen', userId: 1 })); // the owner comes back with the old one
    expect((await rows()).map((row) => row.user_id)).toEqual([2]);
    expect(await tokens.consume(issued(thief)!)).toStrictEqual(err({ kind: 'invalid' })); // the thief is out too
  });

  it('keeps the revocation of a theft and the removal of an expired token inside a transaction that returns the err', async () => {
    const stolen = await tokens.create(1, inAMonth());
    await tokens.create(1, inAMonth());
    await tokens.consume(stolen);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    const theft = await connections.transaction(() => tokens.consume(stolen));
    expect(theft).toStrictEqual(err({ kind: 'stolen', userId: 1 }));
    expect(await rows()).toEqual([]);
    vi.useRealTimers();
    const expired = await tokens.create(2, new Date(Date.now() - 1000));
    expect(await connections.transaction(() => tokens.consume(expired))).toStrictEqual(err({ kind: 'invalid' }));
    expect(await rows()).toEqual([]);
  });

  it('names every error kind', async () => {
    const result = await tokens.consume(`${'a'.repeat(22)}.${'b'.repeat(43)}`);
    if (result.ok) throw new Error('unexpected');
    const kind: RememberTokenError['kind'] = result.error.kind;
    switch (kind) {
      case 'invalid':
      case 'stolen':
        break;
      default:
        kind satisfies never;
    }
  });

  it('accepts the previous validator within the grace period — two tabs at once are no theft', async () => {
    const cookie = await tokens.create(1, inAMonth());
    const [first, second] = await Promise.all([tokens.consume(cookie), tokens.consume(cookie)]);
    expect([first!.ok, second!.ok]).toEqual([true, true]);
    expect([first!, second!].map(issued).filter(Boolean).length).toBeLessThanOrEqual(1); // at most one rotation won
    expect(await tokens.consume(cookie)).toMatchObject({ ok: true, value: { cookie: undefined } }); // still within 60 s
    expect((await rows()).map((row) => row.user_id)).toEqual([1]);
  });

  it('refuses expired tokens and removes them', async () => {
    const cookie = await tokens.create(1, new Date(Date.now() - 1000));
    expect(await tokens.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await rows()).toEqual([]);
  });

  it('refuses malformed cookies without asking the database', async () => {
    const queries: string[] = [];
    const stop = connections.onQuery((query) => queries.push(query.sql));
    for (const cookie of ['', 'x', 'a.b', `${'a'.repeat(22)}.${'b'.repeat(42)}`, `${'a'.repeat(22)}.${'b'.repeat(43)}.c`, "' or 1=1 --"]) {
      expect(await tokens.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    }
    stop();
    expect(queries).toEqual([]);
    expect(await tokens.consume(`${'a'.repeat(22)}.${'b'.repeat(43)}`)).toStrictEqual(err({ kind: 'invalid' })); // well-formed but unknown
  });

  it('forgets one device, or every device of a user but the current one', async () => {
    const laptop = await tokens.create(1, inAMonth());
    const phone = await tokens.create(1, inAMonth());
    const tablet = await tokens.create(1, inAMonth());
    await tokens.forget(tablet);
    expect(await tokens.consume(tablet)).toStrictEqual(err({ kind: 'invalid' }));
    await tokens.forgetUser(1, laptop);
    expect(await tokens.consume(phone)).toStrictEqual(err({ kind: 'invalid' }));
    expect((await tokens.consume(laptop)).ok).toBe(true);
  });
});
