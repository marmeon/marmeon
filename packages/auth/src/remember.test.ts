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

  it('exists() finds a token by its selector, and says false for a deleted token and a malformed cookie', async () => {
    const cookie = await tokens.create(1, inAMonth(), 'fp');
    expect(await tokens.exists(cookie)).toBe(true);
    expect(await tokens.exists(`${cookie.split('.')[0]}.${'x'.repeat(43)}`), 'the validator is not checked').toBe(true);
    expect(await tokens.exists('garbage')).toBe(false);
    expect(await tokens.exists('')).toBe(false);
    await tokens.forgetUser(1);
    expect(await tokens.exists(cookie)).toBe(false);
  });

  it('hands out selector.validator and stores only the selector and a hash of the validator', async () => {
    const cookie = await tokens.create(1, inAMonth(), 'fp');
    expect(cookie).toMatch(/^[\w-]{22}\.[\w-]{43}$/);
    const [selector, validator] = cookie.split('.') as [string, string];
    const [row] = await rows();
    expect(row).toMatchObject({ user_id: 1, selector });
    expect(row!.validator_hash).not.toContain(validator);
    expect(JSON.stringify(await connections.get<any>().selectFrom(REMEMBER_TABLE).selectAll().execute())).not.toContain(validator);
  });

  it('stores the fingerprint it was made with, keeps it over a rotation and replaces it with rebind()', async () => {
    const cookie = await tokens.create(1, inAMonth(), 'first-fingerprint');
    const first = await tokens.consume(cookie);
    expect(first.ok && first.value.fingerprint).toBe('first-fingerprint');
    await tokens.rebind(1, issued(first)!, 'second-fingerprint');
    await tokens.rebind(2, issued(first)!, 'foreign-fingerprint'); // another user's id: not re-stamped
    const second = await tokens.consume(issued(first)!);
    expect(second.ok && second.value.fingerprint).toBe('second-fingerprint');
    await connections.get<any>().updateTable(REMEMBER_TABLE).set({ account_fingerprint: null }).execute();
    const bare = await tokens.consume(issued(second)!);
    expect(bare.ok && bare.value.fingerprint).toBeUndefined();
  });

  it('consume keeps createdAt over a rotation', async () => {
    const first = await tokens.consume(await tokens.create(1, inAMonth(), 'fp'));
    const second = await tokens.consume(issued(first)!);
    expect(first.ok && second.ok && second.value.createdAt).toEqual(first.ok && first.value.createdAt);
  });

  it('accepts a valid cookie and rotates the validator — the selector stays', async () => {
    const cookie = await tokens.create(1, inAMonth(), 'fp');
    const result = await tokens.consume(cookie);
    expect(result.ok && result.value).toMatchObject({ userId: 1, cookie: expect.stringMatching(/^[\w-]{22}\.[\w-]{43}$/) });
    const rotated = issued(result)!;
    expect(rotated.split('.')[0]).toBe(cookie.split('.')[0]);
    expect(rotated).not.toBe(cookie);
    expect((await tokens.consume(rotated)).ok).toBe(true);
  });

  it('theft: an old validator after the grace period drops every token of the user', async () => {
    const stolen = await tokens.create(1, inAMonth(), 'fp');
    await tokens.create(1, inAMonth(), 'fp'); // another device of the same user
    await tokens.create(2, inAMonth(), 'fp'); // someone else
    const thief = await tokens.consume(stolen); // the thief uses the copied cookie first: rotated
    expect(thief.ok).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect(await tokens.consume(stolen)).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: true })); // the owner comes back with the old one
    expect((await rows()).map((row) => row.user_id)).toEqual([2]);
    expect(await tokens.consume(issued(thief)!)).toStrictEqual(err({ kind: 'invalid' })); // the thief is out too
  });

  it('takes the previous validator for 9 seconds after the rotation, and for a theft after 11', async () => {
    const cookie = await tokens.create(1, inAMonth(), 'fp');
    await tokens.consume(cookie);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 9000 });
    expect(await tokens.consume(cookie)).toMatchObject({ ok: true, value: { cookie: undefined } });
    vi.setSystemTime(Date.now() + 2000);
    expect(await tokens.consume(cookie)).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: true }));
  });

  it('theft: a validator that was never issued revokes the tokens, with only the `reused` flag false (the owner is still told)', async () => {
    const cookie = await tokens.create(1, inAMonth(), 'fp');
    await tokens.create(1, inAMonth(), 'fp');
    expect(await tokens.consume(`${cookie.split('.')[0]}.${'x'.repeat(43)}`)).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: false }));
    expect(await rows()).toEqual([]);
  });

  it('theft: of parallel replays only one reports it', async () => {
    const stolen = await tokens.create(1, inAMonth(), 'fp');
    await tokens.consume(stolen);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    const results = await Promise.all([1, 2, 3, 4].map(() => tokens.consume(stolen)));
    expect(results.filter((result) => !result.ok && result.error.kind === 'stolen')).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.kind === 'invalid')).toHaveLength(3);
    expect(await rows()).toEqual([]);
  });

  it('theft: a failure while the tokens are revoked deletes nothing, and the next replay reports it again', async () => {
    const copied = await tokens.create(1, inAMonth(), 'fp');
    const other = await tokens.create(1, inAMonth(), 'fp');
    await tokens.consume(copied);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    let armed = true;
    const flaky = new DatabaseRememberTokens(failingOnce(connections, () => armed, () => (armed = false)), new SystemClock());
    await expect(flaky.consume(copied)).rejects.toThrow('connection lost');
    expect(await rows()).toHaveLength(2);
    expect(await flaky.consume(copied)).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: true }));
    expect(await rows()).toEqual([]);
    expect(await tokens.exists(other)).toBe(false);
  });

  it('keeps the revocation of a theft and the removal of an expired token inside a transaction that returns the err', async () => {
    const stolen = await tokens.create(1, inAMonth(), 'fp');
    await tokens.create(1, inAMonth(), 'fp');
    await tokens.consume(stolen);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    const theft = await connections.transaction(() => tokens.consume(stolen));
    expect(theft).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: true }));
    expect(await rows()).toEqual([]);
    vi.useRealTimers();
    const expired = await tokens.create(2, new Date(Date.now() - 1000), 'fp');
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
    const cookie = await tokens.create(1, inAMonth(), 'fp');
    const [first, second] = await Promise.all([tokens.consume(cookie), tokens.consume(cookie)]);
    expect([first!.ok, second!.ok]).toEqual([true, true]);
    expect([first!, second!].map(issued).filter(Boolean).length).toBeLessThanOrEqual(1); // at most one rotation won
    expect(await tokens.consume(cookie)).toMatchObject({ ok: true, value: { cookie: undefined } }); // still within 10 s
    expect((await rows()).map((row) => row.user_id)).toEqual([1]);
  });

  it('refuses expired tokens and removes them', async () => {
    const cookie = await tokens.create(1, new Date(Date.now() - 1000), 'fp');
    expect(await tokens.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await rows()).toEqual([]);
  });

  it('prune deletes expired tokens and tokens older than the given days — all of them with 0', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 20 * 86_400_000 });
    await tokens.create(1, inAMonth(), 'fp'); // made 20 days ago, still valid by its row
    vi.setSystemTime(Date.now() + 20 * 86_400_000);
    await tokens.create(2, inAMonth(), 'fp');
    await tokens.create(3, new Date(Date.now() - 1000), 'fp'); // expired
    expect(await tokens.prune(30)).toBe(1); // only the expired one
    expect(await tokens.prune(10)).toBe(1); // the 20-day-old one: older than the lowered setting
    expect((await rows()).map((row) => Number(row.user_id))).toEqual([2]);
    expect(await tokens.prune(0)).toBe(1); // 0: remember-me is off
    expect(await rows()).toEqual([]);
  });

  it.runIf(driver === 'sqlite')('refuses a token with an unreadable expiry and removes it', async () => {
    const cookie = await tokens.create(1, inAMonth(), 'fp');
    await connections.get<any>().updateTable(REMEMBER_TABLE).set({ expires_at: 'not a date' }).execute();
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
    const laptop = await tokens.create(1, inAMonth(), 'fp');
    const phone = await tokens.create(1, inAMonth(), 'fp');
    const tablet = await tokens.create(1, inAMonth(), 'fp');
    await tokens.forget(tablet);
    expect(await tokens.consume(tablet)).toStrictEqual(err({ kind: 'invalid' }));
    await tokens.forgetUser(1, laptop);
    expect(await tokens.consume(phone)).toStrictEqual(err({ kind: 'invalid' }));
    expect((await tokens.consume(laptop)).ok).toBe(true);
  });
});

/** Connections whose first delete that names `user_id` throws, once `armed()` says so: the statement that revokes a whole account. */
function failingOnce(connections: Connections, armed: () => boolean, disarm: () => void): Connections {
  const wrap = (builder: any): any =>
    new Proxy(builder, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== 'function') return value;
        if (property === 'execute' || property === 'executeTakeFirst') {
          return (...args: unknown[]) => {
            if (armed() && String(target.compile().sql).includes('"user_id"')) {
              disarm();
              throw new Error('connection lost');
            }
            return value.apply(target, args);
          };
        }
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          return result !== null && typeof result === 'object' && 'compile' in result ? wrap(result) : result;
        };
      },
    });
  return new Proxy(connections, {
    get(target, property) {
      const value = (target as any)[property];
      if (property !== 'get') return typeof value === 'function' ? value.bind(target) : value;
      return (...args: unknown[]) => {
        const db = value.apply(target, args);
        return new Proxy(db, { get: (inner, name) => (name === 'deleteFrom' ? (...a: unknown[]) => wrap(inner.deleteFrom(...a)) : typeof inner[name] === 'function' ? inner[name].bind(inner) : inner[name]) });
      };
    },
  });
}
