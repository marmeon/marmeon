import { TestClock } from '@marmeon/core/testing';
import type { Connections } from '@marmeon/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, migratedConnections } from './__fixtures__/databases.ts';
import { DatabaseSignIns, SEEN_GRANULARITY_SECONDS, SIGN_INS_TABLE, type SignInsTable, type SignInWindow } from './sign-ins.ts';

const WINDOW: SignInWindow = { idleSeconds: 3600, maxSeconds: 86_400 };
const FINGERPRINT = 'f'.repeat(43);

describe.each(drivers)('DatabaseSignIns on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let clock: TestClock;
  let signIns: DatabaseSignIns;
  const inAMonth = () => new Date(clock.now() + 30 * 86_400_000);
  /** A new sign-in that holds a remember-me token; its id, and the cookie of the token. */
  const remembered = async (userId: number, userAgent: string | undefined, until = inAMonth()) => {
    const id = await signIns.create({ userId, userAgent });
    return { id, cookie: await signIns.issueToken(userId, id, { until, fingerprint: FINGERPRINT }) };
  };
  const rows = () => connections.get<{ [SIGN_INS_TABLE]: SignInsTable }>().selectFrom(SIGN_INS_TABLE).selectAll().execute();

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<any>().deleteFrom(SIGN_INS_TABLE).execute();
    clock = new TestClock();
    clock.freeze(Date.parse('2026-10-05T10:00:00Z'));
    signIns = new DatabaseSignIns(connections, clock);
  });

  it('creates a sign-in with a 128-bit id, which is then seen; ending it removes it', async () => {
    const id = await signIns.create({ userId: 1, userAgent: 'Agent' });
    expect(id).toMatch(/^[\w-]{22}$/);
    expect(await signIns.seen(1, id, false)).toBe(true);
    expect(await signIns.end(1, id)).toBe(true);
    expect(await signIns.seen(1, id, false)).toBe(false);
    expect(await signIns.end(1, id)).toBe(false);
  });

  it('stores no address and no secret — only the columns of the table', async () => {
    await signIns.create({ userId: 1, userAgent: 'Agent' });
    expect(Object.keys((await rows())[0]!).sort()).toEqual(
      ['created_at', 'id', 'last_seen_at', 'remember_created_at', 'remember_fingerprint', 'remember_rotated_at', 'remember_until', 'signed_in_at', 'updated_at', 'user_agent', 'user_id'],
    );
  });

  it('only ever touches the rows of the named user', async () => {
    const mine = await signIns.create({ userId: 1, userAgent: 'Agent' });
    const theirs = await signIns.create({ userId: 2, userAgent: 'Agent' });
    expect(await signIns.seen(1, theirs, true)).toBe(false);
    expect(await signIns.end(1, theirs), 'another user\'s id is none').toBe(false);
    expect(await signIns.endAll(1)).toBe(1);
    expect(await signIns.seen(2, theirs, false)).toBe(true);
    expect(await signIns.seen(1, mine, false)).toBe(false);
    expect((await signIns.list(1, WINDOW)).map((record) => record.id)).toEqual([]);
    expect((await signIns.list(2, WINDOW)).map((record) => record.id)).toEqual([theirs]);
  });

  it('endEveryone deletes the rows of every user, dead or alive, and counts them', async () => {
    await signIns.create({ userId: 1, userAgent: undefined });
    await signIns.create({ userId: 2, userAgent: undefined });
    await remembered(2, undefined);
    expect(await signIns.endEveryone()).toBe(3);
    expect(await rows()).toEqual([]);
    expect(await signIns.endEveryone()).toBe(0);
  });

  it('endAll keeps exactly the exception', async () => {
    const keep = await signIns.create({ userId: 1, userAgent: undefined });
    await signIns.create({ userId: 1, userAgent: undefined });
    await signIns.create({ userId: 1, userAgent: undefined });
    const other = await signIns.create({ userId: 2, userAgent: undefined });
    expect(await signIns.endAll(1, keep)).toBe(2);
    expect((await rows()).map((row) => row.id).sort()).toEqual([keep, other].sort());
    expect(await signIns.endAll(1, '../x'), 'a malformed exception keeps nothing').toBe(1);
  });

  it('a token makes the sign-in listed as remembered, and dropping it ends that — for its owner only', async () => {
    const id = await signIns.create({ userId: 1, userAgent: undefined });
    expect((await signIns.list(1, WINDOW))[0]!.remembered).toBe(false);
    const cookie = await signIns.issueToken(1, id, { until: inAMonth(), fingerprint: FINGERPRINT });
    expect((await signIns.list(1, WINDOW))[0]!.remembered).toBe(true);
    await signIns.dropToken(2, id); // not the owner: nothing changes
    expect((await signIns.list(1, WINDOW))[0]!.remembered).toBe(true);
    await signIns.dropToken(1, id);
    expect((await signIns.list(1, WINDOW))[0]!.remembered).toBe(false);
    expect(await signIns.consume(cookie)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(await rows(), 'the row stays').toHaveLength(1);
  });

  describe('seen', () => {
    const lastSeen = async () => new Date((await rows())[0]!.last_seen_at).getTime();

    it('writes last_seen_at only once the granularity has passed', async () => {
      const id = await signIns.create({ userId: 1, userAgent: undefined });
      const created = clock.now();
      clock.travel({ seconds: SEEN_GRANULARITY_SECONDS - 1 });
      expect(await signIns.seen(1, id, true)).toBe(true);
      expect(await lastSeen()).toBe(created);
      clock.travel({ seconds: 2 });
      expect(await signIns.seen(1, id, true)).toBe(true);
      expect(await lastSeen()).toBe(clock.now());
    });

    it('never writes without touch', async () => {
      const id = await signIns.create({ userId: 1, userAgent: undefined });
      const created = clock.now();
      clock.travel({ hours: 1 });
      expect(await signIns.seen(1, id, false)).toBe(true);
      expect(await lastSeen()).toBe(created);
    });

    it('never creates a row', async () => {
      expect(await signIns.seen(1, 'b'.repeat(22), true)).toBe(false);
      expect(await rows()).toEqual([]);
    });
  });

  describe('list and prune', () => {
    it('shows what is within both limits or remembered — and prune deletes exactly the rest', async () => {
      const fresh = await signIns.create({ userId: 1, userAgent: 'fresh' });
      const idle = await signIns.create({ userId: 1, userAgent: 'idle' });
      const old = await signIns.create({ userId: 1, userAgent: 'old' });
      const { id: kept } = await remembered(1, 'remembered');
      const { id: expiredRemember } = await remembered(1, 'expired remember', new Date(clock.now() + 3_600_000));
      const other = await signIns.create({ userId: 2, userAgent: 'other' });
      const db = connections.get<any>();
      const set = (id: string, values: Record<string, Date>) => db.updateTable(SIGN_INS_TABLE).set(values).where('id', '=', id).execute();
      const ago = (seconds: number) => new Date(clock.now() - seconds * 1000);
      await set(idle, { last_seen_at: ago(WINDOW.idleSeconds + SEEN_GRANULARITY_SECONDS + 60) });
      await set(old, { signed_in_at: ago(WINDOW.maxSeconds + 60) });
      await set(kept, { last_seen_at: ago(10 * 86_400), signed_in_at: ago(10 * 86_400) }); // the cookie, not the session, keeps it
      await set(expiredRemember, { last_seen_at: ago(WINDOW.idleSeconds + SEEN_GRANULARITY_SECONDS + 60) });
      clock.travel({ hours: 2 }); // the one-hour remember-me of `expiredRemember` is over; `fresh` is beyond the idle limit too
      await set(fresh, { last_seen_at: ago(60) });
      await set(other, { last_seen_at: ago(60) });

      const listed = (await signIns.list(1, WINDOW)).map((record) => record.userAgent);
      expect(listed).toEqual(['fresh', 'remembered']); // most recently seen first
      expect((await signIns.list(2, WINDOW)).map((record) => record.userAgent)).toEqual(['other']);

      expect(await signIns.prune(WINDOW, 30)).toBe(3);
      expect((await rows()).map((row) => row.user_agent).sort()).toEqual(['fresh', 'other', 'remembered']);
      expect(await signIns.prune(WINDOW, 30)).toBe(0);
    });

    it('lists the record as the store knows it', async () => {
      await remembered(1, 'Agent');
      const [record] = await signIns.list(1, WINDOW);
      expect(record).toMatchObject({ userId: 1, userAgent: 'Agent', remembered: true });
      expect(record!.signedInAt).toEqual(new Date(clock.now()));
      expect(record!.lastSeenAt).toEqual(new Date(clock.now()));
      expect(record!.createdAt).toBeInstanceOf(Date);
    });
  });

  it('does not list an expired remember-me as active', async () => {
    await remembered(1, undefined, new Date(clock.now() + 60_000));
    expect((await signIns.list(1, WINDOW))[0]!.remembered).toBe(true);
    clock.travel({ seconds: 120 });
    expect((await signIns.list(1, WINDOW))[0]!.remembered).toBe(false);
  });

  it('asks the database nothing for a malformed id', async () => {
    const queries: string[] = [];
    const stop = connections.onQuery((query) => queries.push(query.sql));
    for (const id of ['', '../x', 'a'.repeat(21), 'a'.repeat(23), "' or 1=1 --"]) {
      expect(await signIns.seen(1, id, true)).toBe(false);
      expect(await signIns.end(1, id)).toBe(false);
      await signIns.dropToken(1, id);
    }
    stop();
    expect(queries).toEqual([]);
  });

  it('strips control characters from the user agent and cuts it to 255 characters', async () => {
    await signIns.create({ userId: 1, userAgent: 'Evil\n\u0000Agent\r\t\u202e' });
    await signIns.create({ userId: 1, userAgent: 'x'.repeat(1000) });
    await signIns.create({ userId: 1, userAgent: '\n\u0000' });
    await signIns.create({ userId: 1, userAgent: undefined });
    const agents = (await rows()).map((row) => row.user_agent);
    expect(agents).toContain('EvilAgent');
    expect(agents).toContain('x'.repeat(255));
    expect(agents.filter((agent) => agent === null)).toHaveLength(2);
  });
});
