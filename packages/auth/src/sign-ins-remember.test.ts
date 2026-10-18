import { err, SystemClock, type Result } from '@marmeon/core';
import { secret, type Connections } from '@marmeon/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { DatabaseSignIns, SIGN_INS_TABLE, type RememberedDevice, type RememberTokenError, type SignInsTable, type SignInWindow } from './sign-ins.ts';

/** Every row is alive by its session: what a test looks at is the token. */
const LONG: SignInWindow = { idleSeconds: 365 * 86_400, maxSeconds: 365 * 86_400 };
const NARROW: SignInWindow = { idleSeconds: 60, maxSeconds: 3600 };

// The remember-me token on the sign-in row: every case of a remember-me store, and the ones the row adds.
describe.each(drivers)('the remember-me token of DatabaseSignIns on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let signIns: DatabaseSignIns;
  const inAMonth = () => new Date(Date.now() + 30 * 86_400_000);
  const issued = (result: Result<RememberedDevice, RememberTokenError>) => (result.ok ? result.value.cookie : undefined);
  const rows = () =>
    connections
      .get<{ [SIGN_INS_TABLE]: SignInsTable }>()
      .selectFrom(SIGN_INS_TABLE)
      .select((eb) => ['id', 'user_id', secret(eb, 'remember_selector'), secret(eb, 'remember_validator_hash')])
      .execute();
  /** A new sign-in of the user with a token on it: the cookie, and the id of the row. */
  async function issue(userId: number, until = inAMonth(), fingerprint = 'fp') {
    const id = await signIns.create({ userId, userAgent: 'Agent' });
    return { id, cookie: await signIns.issueToken(userId, id, { until, fingerprint }) };
  }
  const tokenColumns = () => connections.get<any>().selectFrom(SIGN_INS_TABLE).selectAll().execute();

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
    signIns = new DatabaseSignIns(connections, new SystemClock());
  });
  afterAll(() => close());
  beforeEach(() => connections.get<any>().deleteFrom(SIGN_INS_TABLE).execute());
  afterEach(() => vi.useRealTimers());

  it('remembered() finds a token by its selector, and says false for an ended sign-in, a row without a token and a malformed cookie', async () => {
    const { id, cookie } = await issue(1);
    expect(await signIns.remembered(cookie)).toBe(true);
    expect(await signIns.remembered(`${cookie.split('.')[0]}.${'x'.repeat(43)}`), 'the validator is not checked').toBe(true);
    expect(await signIns.remembered('garbage')).toBe(false);
    expect(await signIns.remembered('')).toBe(false);
    await signIns.dropToken(1, id);
    expect(await signIns.remembered(cookie)).toBe(false);
    const again = await signIns.issueToken(1, id, { until: inAMonth(), fingerprint: 'fp' });
    await signIns.end(1, id);
    expect(await signIns.remembered(again)).toBe(false);
  });

  it('hands out selector.validator and stores only the selector and a hash of the validator', async () => {
    const { id, cookie } = await issue(1);
    expect(cookie).toMatch(/^[\w-]{22}\.[\w-]{43}$/);
    const [selector, validator] = cookie.split('.') as [string, string];
    const [row] = await rows();
    expect(row).toMatchObject({ id, user_id: 1, remember_selector: selector });
    expect(row!.remember_validator_hash).not.toContain(validator);
    expect(JSON.stringify(await tokenColumns())).not.toContain(validator);
  });

  it('stores the fingerprint it was made with, keeps it over a rotation and replaces it with rebind()', async () => {
    const { cookie } = await issue(1, inAMonth(), 'first-fingerprint');
    const first = await signIns.consume(cookie);
    expect(first.ok && first.value.fingerprint).toBe('first-fingerprint');
    expect(await signIns.rebind(1, issued(first)!, 'second-fingerprint')).toStrictEqual({ ok: true, value: undefined });
    expect(await signIns.rebind(2, issued(first)!, 'foreign-fingerprint'), 'another user\'s id: not re-stamped').toStrictEqual(err({ kind: 'invalid' }));
    const second = await signIns.consume(issued(first)!);
    expect(second.ok && second.value.fingerprint).toBe('second-fingerprint');
    await connections.get<any>().updateTable(SIGN_INS_TABLE).set({ remember_fingerprint: null }).execute();
    const bare = await signIns.consume(issued(second)!);
    expect(bare.ok && bare.value.fingerprint).toBeUndefined();
  });

  it('rebind() refuses a malformed, an expired and an unknown cookie, and takes the previous validator only inside the grace period', async () => {
    const { cookie } = await issue(1);
    expect(await signIns.rebind(1, 'garbage', 'fp2')).toStrictEqual(err({ kind: 'invalid' }));
    expect(await signIns.rebind(1, `${'a'.repeat(22)}.${'b'.repeat(43)}`, 'fp2')).toStrictEqual(err({ kind: 'invalid' }));
    const expired = await issue(1, new Date(Date.now() - 1000));
    expect(await signIns.rebind(1, expired.cookie, 'fp2')).toStrictEqual(err({ kind: 'invalid' }));
    const rotated = issued(await signIns.consume(cookie))!;
    expect((await signIns.rebind(1, cookie, 'fp2')).ok, 'the previous validator, just after the rotation').toBe(true);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect(await signIns.rebind(1, cookie, 'fp3'), 'the previous validator, long after').toStrictEqual(err({ kind: 'stolen', userId: 1, reused: true }));
    expect(await signIns.remembered(rotated), 'a copy revokes every sign-in of the user').toBe(false);
    expect(await rows()).toEqual([]);
  });

  it('rebind() with a validator that was never issued revokes every sign-in of the user and no other', async () => {
    const { cookie } = await issue(1);
    await issue(1);
    const other = await issue(2);
    expect(await signIns.rebind(1, `${cookie.split('.')[0]}.${'x'.repeat(43)}`, 'fp2')).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: false }));
    expect((await rows()).map((row) => row.user_id)).toEqual([2]);
    expect(await signIns.remembered(other.cookie)).toBe(true);
  });

  it('consume keeps createdAt over a rotation, and names the sign-in', async () => {
    const { id, cookie } = await issue(1);
    const first = await signIns.consume(cookie);
    const second = await signIns.consume(issued(first)!);
    expect(first.ok && second.ok && second.value.createdAt).toEqual(first.ok && first.value.createdAt);
    expect(first.ok && first.value.signIn).toBe(id);
    expect(second.ok && second.value.signIn).toBe(id);
  });

  it('accepts a valid cookie and rotates the validator — the selector stays', async () => {
    const { cookie } = await issue(1);
    const result = await signIns.consume(cookie);
    expect(result.ok && result.value).toMatchObject({ userId: 1, cookie: expect.stringMatching(/^[\w-]{22}\.[\w-]{43}$/) });
    const rotated = issued(result)!;
    expect(rotated.split('.')[0]).toBe(cookie.split('.')[0]);
    expect(rotated).not.toBe(cookie);
    expect((await signIns.consume(rotated)).ok).toBe(true);
  });

  it('theft: an old validator after the grace period ends every sign-in of the user and no one else\'s', async () => {
    const stolen = await issue(1);
    await issue(1); // another device of the same user
    await signIns.create({ userId: 1, userAgent: 'No remember-me' }); // a sign-in without a token goes too
    const other = await issue(2); // someone else
    const thief = await signIns.consume(stolen.cookie); // the thief uses the copied cookie first: rotated
    expect(thief.ok).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect(await signIns.consume(stolen.cookie)).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: true })); // the owner comes back with the old one
    expect((await rows()).map((row) => row.user_id)).toEqual([2]);
    expect((await rows())[0]!.id).toBe(other.id);
    expect(await signIns.consume(issued(thief)!)).toStrictEqual(err({ kind: 'invalid' })); // the thief is out too
    expect((await signIns.consume(other.cookie)).ok, 'the other user\'s token still works').toBe(true);
  });

  it('takes the previous validator for 9 seconds after the rotation, and for a theft after 11', async () => {
    const { cookie } = await issue(1);
    await signIns.consume(cookie);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 9000 });
    expect(await signIns.consume(cookie)).toMatchObject({ ok: true, value: { cookie: undefined } });
    vi.setSystemTime(Date.now() + 2000);
    expect(await signIns.consume(cookie)).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: true }));
  });

  it('theft: a validator that was never issued revokes the sign-ins, with only the `reused` flag false (the owner is still told)', async () => {
    const { cookie } = await issue(1);
    await issue(1);
    expect(await signIns.consume(`${cookie.split('.')[0]}.${'x'.repeat(43)}`)).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: false }));
    expect(await rows()).toEqual([]);
  });

  it('theft: of parallel replays only one reports it', async () => {
    const { cookie: stolen } = await issue(1);
    await signIns.consume(stolen);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    const results = await Promise.all([1, 2, 3, 4].map(() => signIns.consume(stolen)));
    expect(results.filter((result) => !result.ok && result.error.kind === 'stolen')).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.kind === 'invalid')).toHaveLength(3);
    expect(await rows()).toEqual([]);
  });

  it('theft: a failure while the sign-ins are revoked deletes nothing, and the next replay reports it again', async () => {
    const copied = await issue(1);
    const other = await issue(1);
    await signIns.consume(copied.cookie);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    let armed = true;
    const flaky = new DatabaseSignIns(failingOnce(connections, () => armed, () => (armed = false)), new SystemClock());
    await expect(flaky.consume(copied.cookie)).rejects.toThrow('connection lost');
    expect(await rows()).toHaveLength(2);
    expect(await flaky.consume(copied.cookie)).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: true }));
    expect(await rows()).toEqual([]);
    expect(await signIns.remembered(other.cookie)).toBe(false);
  });

  it('keeps the revocation of a theft and the removal of an expired token inside a transaction that returns the err', async () => {
    const stolen = await issue(1);
    await issue(1);
    await signIns.consume(stolen.cookie);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    const theft = await connections.transaction(() => signIns.consume(stolen.cookie));
    expect(theft).toStrictEqual(err({ kind: 'stolen', userId: 1, reused: true }));
    expect(await rows()).toEqual([]);
    vi.useRealTimers();
    const expired = await issue(2, new Date(Date.now() - 1000));
    expect(await connections.transaction(() => signIns.consume(expired.cookie))).toStrictEqual(err({ kind: 'invalid' }));
    expect(await signIns.remembered(expired.cookie)).toBe(false);
  });

  it('refuses the cookie when the row is deleted between the read and the rotation — no sign-in without a token', async () => {
    const { id, cookie } = await issue(1);
    let armed = true;
    const racing = new DatabaseSignIns(beforeRotation(connections, () => armed, async () => { armed = false; await signIns.end(1, id); }), new SystemClock());
    expect(await racing.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await rows()).toEqual([]);
  });

  it('refuses the cookie when the token is dropped or replaced between the read and the rotation', async () => {
    const first = await issue(1);
    let armed = true;
    const dropping = new DatabaseSignIns(beforeRotation(connections, () => armed, async () => { armed = false; await signIns.dropToken(1, first.id); }), new SystemClock());
    expect(await dropping.consume(first.cookie)).toStrictEqual(err({ kind: 'invalid' }));
    const second = await issue(2);
    armed = true;
    const replacing = new DatabaseSignIns(beforeRotation(connections, () => armed, async () => { armed = false; await signIns.issueToken(2, second.id, { until: inAMonth(), fingerprint: 'new' }); }), new SystemClock());
    expect(await replacing.consume(second.cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await signIns.remembered(second.cookie), 'the new token is untouched by the stale request').toBe(false);
  });

  it('takes a cookie that another request rotated between the read and the rotation as the grace case: signed in, without a new cookie', async () => {
    const { cookie } = await issue(1);
    let armed = true;
    const racing = new DatabaseSignIns(beforeRotation(connections, () => armed, async () => { armed = false; await signIns.consume(cookie); }), new SystemClock());
    expect(await racing.consume(cookie)).toMatchObject({ ok: true, value: { userId: 1, cookie: undefined } });
  });

  it('refuses the cookie when two more rotations passed between the read and the rotation: it is no longer the previous validator', async () => {
    const { cookie } = await issue(1);
    let rotated: string | undefined;
    let armed = true;
    const racing = new DatabaseSignIns(
      beforeRotation(connections, () => armed, async () => {
        armed = false;
        rotated = issued(await signIns.consume(cookie));
        rotated = issued(await signIns.consume(rotated!));
      }),
      new SystemClock(),
    );
    expect(await racing.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await rows()).toHaveLength(1);
    expect((await signIns.consume(rotated!)).ok, 'the newest cookie still works').toBe(true);
  });

  it('an expired token is taken off only while the row still holds that selector: a token issued meanwhile stays', async () => {
    const { id, cookie } = await issue(1, new Date(Date.now() - 1000));
    let fresh: string | undefined;
    let armed = true;
    const racing = new DatabaseSignIns(
      beforeRotation(connections, () => armed, async () => {
        armed = false;
        fresh = await signIns.issueToken(1, id, { until: inAMonth(), fingerprint: 'new' });
      }),
      new SystemClock(),
    );
    expect(await racing.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await signIns.remembered(fresh!)).toBe(true);
  });

  it('a rotation counts as a sign-in that starts now: the row outlives the session window while the token lives, and not after the token ends', async () => {
    const { id, cookie } = await issue(1);
    await connections.get<any>().updateTable(SIGN_INS_TABLE).set({ signed_in_at: new Date(Date.now() - 5 * 3600_000) }).where('id', '=', id).execute();
    expect((await signIns.consume(cookie)).ok).toBe(true);
    const [row] = await tokenColumns();
    expect(Date.now() - new Date(row!.signed_in_at).getTime()).toBeLessThan(60_000);
    await connections.get<any>().updateTable(SIGN_INS_TABLE).set({ remember_until: new Date(Date.now() - 1000), last_seen_at: new Date(Date.now() - 300_000) }).execute();
    expect(await signIns.prune(NARROW, 30)).toBe(0);
    expect((await rows()).map((r) => r.id)).toEqual([id]);
  });

  it('rebind() for another user with the selector and a wrong validator is refused and revokes nothing', async () => {
    const { cookie } = await issue(1);
    await issue(1);
    expect(await signIns.rebind(2, `${cookie.split('.')[0]}.${'x'.repeat(43)}`, 'fp2')).toStrictEqual(err({ kind: 'invalid' }));
    expect(await rows()).toHaveLength(2);
    expect((await signIns.consume(cookie)).ok).toBe(true);
  });

  it('names every error kind', async () => {
    const result = await signIns.consume(`${'a'.repeat(22)}.${'b'.repeat(43)}`);
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
    const { cookie } = await issue(1);
    const [first, second] = await Promise.all([signIns.consume(cookie), signIns.consume(cookie)]);
    expect([first!.ok, second!.ok]).toEqual([true, true]);
    expect([first!, second!].map(issued).filter(Boolean).length).toBeLessThanOrEqual(1); // at most one rotation won
    expect(await signIns.consume(cookie)).toMatchObject({ ok: true, value: { cookie: undefined } }); // still within 10 s
    expect((await rows()).map((row) => row.user_id)).toEqual([1]);
  });

  it('refuses expired tokens and takes them off — the sign-in itself stays', async () => {
    const { id, cookie } = await issue(1, new Date(Date.now() - 1000));
    expect(await signIns.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await rows()).toEqual([expect.objectContaining({ id, remember_selector: null, remember_validator_hash: null })]);
  });

  it('prune() takes off expired tokens and tokens older than the given days — all of them with 0 — and leaves living sign-ins', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 20 * 86_400_000 });
    const old = await issue(1); // made 20 days ago, still valid by its row
    vi.setSystemTime(Date.now() + 20 * 86_400_000);
    const young = await issue(2);
    const expired = await issue(3, new Date(Date.now() - 1000));
    expect(await signIns.prune(LONG, 30)).toBe(0); // the expired token goes, no row
    expect(await signIns.remembered(expired.cookie)).toBe(false);
    expect(await signIns.remembered(old.cookie)).toBe(true);
    expect(await signIns.prune(LONG, 10)).toBe(0); // the 20-day-old one: older than the lowered setting
    expect(await signIns.remembered(old.cookie)).toBe(false);
    expect(await signIns.remembered(young.cookie)).toBe(true);
    expect(await signIns.prune(LONG, 0)).toBe(0); // 0: remember-me is off
    expect(await signIns.remembered(young.cookie)).toBe(false);
    expect(await rows()).toHaveLength(3);
    expect((await signIns.list(2, LONG)).map((signIn) => signIn.remembered), 'no token, not remembered').toEqual([false]);
  });

  it('prune() leaves a row alone while its token lives, and deletes the rows that are over', async () => {
    const living = await issue(1);
    const ended = await issue(2, new Date(Date.now() - 1000));
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 3600_000 });
    expect(await signIns.prune(NARROW, 30)).toBe(1);
    expect((await rows()).map((row) => row.id)).toEqual([living.id]);
    expect(await signIns.remembered(living.cookie)).toBe(true);
    expect(await signIns.remembered(ended.cookie)).toBe(false);
  });

  it('prune() with the days keeps a row whose session lives, and deletes one that is over', async () => {
    const { id } = await issue(1);
    const gone = await issue(2);
    await connections.get<any>().updateTable(SIGN_INS_TABLE).set({ signed_in_at: new Date(Date.now() - 5 * 3600_000), last_seen_at: new Date(Date.now() - 5 * 3600_000) }).where('id', '=', gone.id).execute();
    expect(await signIns.prune(NARROW, 0)).toBe(1);
    expect((await rows()).map((row) => row.id)).toEqual([id]);
  });

  it.runIf(driver === 'sqlite')('refuses a token with an unreadable expiry and takes it off', async () => {
    const { cookie } = await issue(1);
    await connections.get<any>().updateTable(SIGN_INS_TABLE).set({ remember_until: 'not a date' }).execute();
    expect(await signIns.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await signIns.remembered(cookie)).toBe(false);
  });

  it('refuses malformed cookies without asking the database', async () => {
    const queries: string[] = [];
    const stop = connections.onQuery((query) => queries.push(query.sql));
    for (const cookie of ['', 'x', 'a.b', `${'a'.repeat(22)}.${'b'.repeat(42)}`, `${'a'.repeat(22)}.${'b'.repeat(43)}.c`, "' or 1=1 --"]) {
      expect(await signIns.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
      expect(await signIns.remembered(cookie)).toBe(false);
      expect(await signIns.rebind(1, cookie, 'fp')).toStrictEqual(err({ kind: 'invalid' }));
      await signIns.forgetToken(cookie);
    }
    stop();
    expect(queries).toEqual([]);
    expect(await signIns.consume(`${'a'.repeat(22)}.${'b'.repeat(43)}`)).toStrictEqual(err({ kind: 'invalid' })); // well-formed but unknown
  });

  it('forgetToken() ends the sign-in of the device, and endAll() the others but the current one', async () => {
    const laptop = await issue(1);
    const phone = await issue(1);
    const tablet = await issue(1);
    await signIns.forgetToken(tablet.cookie);
    expect(await signIns.consume(tablet.cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await signIns.seen(1, tablet.id, false), 'the row is gone with the token').toBe(false);
    expect(await signIns.endAll(1, laptop.id)).toBe(1);
    expect(await signIns.consume(phone.cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect((await signIns.consume(laptop.cookie)).ok).toBe(true);
  });

  it('forgetToken() with a cookie that is not a token deletes nothing', async () => {
    await issue(1);
    const other = await issue(2);
    await signIns.create({ userId: 1, userAgent: 'No remember-me' });
    const before = await rows();
    await signIns.forgetToken(`${'a'.repeat(22)}.${'b'.repeat(43)}`); // well-formed, unknown selector
    await signIns.forgetToken('garbage');
    await signIns.forgetToken('');
    await signIns.forgetToken(`${'a'.repeat(22)}.`);
    expect(await rows()).toEqual(before);
    expect(await signIns.remembered(other.cookie)).toBe(true);
  });

  it('issueToken() on the sign-in of another user, an ended one or a malformed id throws and changes nothing', async () => {
    const mine = await signIns.create({ userId: 1, userAgent: 'Agent' });
    const theirs = await issue(2);
    const before = await tokenColumns();
    await expect(signIns.issueToken(1, theirs.id, { until: inAMonth(), fingerprint: 'fp' })).rejects.toThrow('no such sign-in');
    await expect(signIns.issueToken(2, mine, { until: inAMonth(), fingerprint: 'fp' })).rejects.toThrow('no such sign-in');
    await expect(signIns.issueToken(1, 'x', { until: inAMonth(), fingerprint: 'fp' })).rejects.toThrow('no such sign-in');
    await signIns.end(1, mine);
    await expect(signIns.issueToken(1, mine, { until: inAMonth(), fingerprint: 'fp' })).rejects.toThrow('no such sign-in');
    expect((await tokenColumns()).filter((row) => row.id !== mine)).toEqual(before.filter((row) => row.id !== mine));
    expect((await signIns.consume(theirs.cookie)).ok, 'the token of the other user is untouched').toBe(true);
  });

  it('issueToken() replaces the token of the row: the old cookie stops working and the sign-in is the same', async () => {
    const { id, cookie } = await issue(1);
    const fresh = await signIns.issueToken(1, id, { until: inAMonth(), fingerprint: 'new' });
    expect(fresh.split('.')[0]).not.toBe(cookie.split('.')[0]);
    expect(await signIns.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    const result = await signIns.consume(fresh);
    expect(result.ok && result.value).toMatchObject({ signIn: id, fingerprint: 'new' });
    expect(await rows()).toHaveLength(1);
  });

  it('dropToken() takes the token off and keeps the row; it names the user', async () => {
    const { id, cookie } = await issue(1);
    await signIns.dropToken(2, id); // another user's id: nothing
    expect(await signIns.remembered(cookie)).toBe(true);
    await signIns.dropToken(1, 'x'); // malformed id: nothing, no error
    await signIns.dropToken(1, id);
    expect(await signIns.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await signIns.seen(1, id, false)).toBe(true);
    expect(await tokenColumns()).toEqual([expect.objectContaining({ remember_until: null, remember_created_at: null, remember_fingerprint: null, remember_rotated_at: null })]);
    expect(await rows(), 'the selector is a secret column: read by name').toEqual([expect.objectContaining({ remember_selector: null, remember_validator_hash: null })]);
  });

  it('consume() of a token whose sign-in was ended is invalid', async () => {
    const { id, cookie } = await issue(1);
    expect(await signIns.end(1, id)).toBe(true);
    expect(await signIns.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
  });

  it('a row with a selector but no validator (not made by issueToken()) is no token', async () => {
    const selector = 'a'.repeat(22);
    const now = new Date();
    await connections
      .get<any>()
      .insertInto(SIGN_INS_TABLE)
      .values({ id: 'c'.repeat(22), user_id: 1, remember_selector: selector, remember_until: inAMonth(), signed_in_at: now, last_seen_at: now, created_at: now, updated_at: now })
      .execute();
    const cookie = `${selector}.${'b'.repeat(43)}`;
    expect(await signIns.consume(cookie)).toStrictEqual(err({ kind: 'invalid' }));
    expect(await signIns.remembered(cookie)).toBe(false);
    expect(await signIns.rebind(1, cookie, 'fp')).toStrictEqual(err({ kind: 'invalid' }));
    expect(await rows()).toHaveLength(1);
  });

  it('shows the token as remembered in list() while it lives, and not after dropToken()', async () => {
    const { id } = await issue(1);
    expect((await signIns.list(1, NARROW)).map((signIn) => signIn.remembered)).toEqual([true]);
    await signIns.dropToken(1, id);
    expect((await signIns.list(1, NARROW)).map((signIn) => signIn.remembered)).toEqual([false]);
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

/** Connections that run `hook` once, right before the update that rotates a validator, when `armed()` says so: another request got in between. */
function beforeRotation(connections: Connections, armed: () => boolean, hook: () => Promise<void>): Connections {
  const wrap = (builder: any): any =>
    new Proxy(builder, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== 'function') return value;
        if (property === 'execute' || property === 'executeTakeFirst') {
          return async (...args: unknown[]) => {
            if (armed() && String(target.compile().sql).includes('"remember_previous_validator_hash"')) await hook();
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
        return new Proxy(db, { get: (inner, name) => (name === 'updateTable' ? (...a: unknown[]) => wrap(inner.updateTable(...a)) : typeof inner[name] === 'function' ? inner[name].bind(inner) : inner[name]) });
      };
    },
  });
}
