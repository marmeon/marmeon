import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql, type Generated } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshConnections, withMysql } from './__fixtures__/databases.ts';
import { UserFactory } from './__fixtures__/factories.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Factories, Migrator, Repository, type Connections, type Timestamp } from './index.ts';
import { uuidv7 } from './mysql-returning.ts';
import { UnsupportedDriverError } from './supported-driver.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

// The MySQL cases run in `pnpm test:mysql`, which sets MARMEON_TEST_MYSQL_URL; the unit cases need no server.

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('a UUIDv7 drawn by the repository', () => {
  it('has the layout of the column default: version 7, variant 8 to b, lower case, 36 characters, the given time first', () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 0, 123);
    const id = uuidv7(now);
    expect(id).toHaveLength(36);
    expect(id).toMatch(V7);
    expect(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(now);
  });

  it('keeps the largest millisecond a 48-bit field holds, and does not repeat', () => {
    expect(uuidv7(2 ** 48 - 1).slice(0, 13)).toBe('ffffffff-ffff');
    expect(new Set(Array.from({ length: 10_000 }, () => uuidv7())).size).toBe(10_000);
  });

  it('draws its time from the host clock', () => {
    const before = Date.now();
    const id = uuidv7();
    const at = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});

interface WriteTables extends FixtureTables {
  coupons: {
    id: Generated<number>;
    email: string;
    code: string;
    note: string | null;
    pin: string | null;
    created_at: Generated<Timestamp>;
    updated_at: Generated<Timestamp>;
    deleted_at: Timestamp | null;
  };
  slots: { slug: string; seats: Generated<number> };
  teams: { id: Generated<string>; name: string };
}

class Coupons extends Repository<'coupons', WriteTables> {
  static table = 'coupons' as const;
}
class Slots extends Repository<'slots', WriteTables> {
  static table = 'slots' as const;
}
class Teams extends Repository<'teams', WriteTables> {
  static table = 'teams' as const;
}
class Users extends Repository<'users', WriteTables> {
  static table = 'users' as const;
}
class Articles extends Repository<'articles', WriteTables> {
  static table = 'articles' as const;
}
class ApiKeys extends Repository<'api_keys', WriteTables> {
  static table = 'api_keys' as const;
}

const root = workspaceTempDir('marmeon-mysql-returning-app-');
const dir = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: dir('auth') },
  { name: 'blog', migrations: dir('blog') },
  { name: 'uuids', migrations: dir('uuids') },
  { name: 'relations-secrets', migrations: dir('relations-secrets') },
  { name: 'mysql-writes', migrations: dir('mysql-writes') },
];

const failure = (work: () => Promise<unknown>) => work().then(() => undefined, (error: unknown) => error);
/** What a call sent to the server, and what it threw. */
async function attempt(connections: Connections, work: () => Promise<unknown>): Promise<{ error: unknown; sent: string[] }> {
  const sent: string[] = [];
  const stop = connections.onQuery((query) => sent.push(query.sql));
  try {
    return { error: await failure(work), sent };
  } finally {
    stop();
  }
}
const count = async (connections: Connections, table: string) => Number((await sql<{ n: string }>`select count(*) as n from ${sql.id(table)}`.execute(connections.get<any>())).rows[0]!.n);

withMysql('writing on MySQL without RETURNING', () => {
  let connections: Connections;
  let close: () => Promise<void>;
  let coupons: Coupons;
  let slots: Slots;
  let sqlite: { connections: Connections; close: () => Promise<void> };

  // DDL on the shared Docker host is slow.
  beforeAll(async () => {
    ({ connections, close } = await freshConnections('mysql'));
    await new Migrator({ modules, root } as unknown as Application, connections).migrate();
    coupons = new Coupons(connections);
    slots = new Slots(connections);
    sqlite = await freshConnections('sqlite');
    await new Migrator({ modules: modules.slice(-1), root } as unknown as Application, sqlite.connections).migrate();
  }, 60_000);
  afterAll(async () => {
    await close();
    await sqlite.close();
  });

  const db = () => connections.get<any>();
  const row = (email: string, code: string, extra: Record<string, unknown> = {}) => ({ email, code, ...extra });

  describe('the compiler', () => {
    const builders = (conn: Connections) => {
      const d = conn.get<any>();
      return {
        returning: () => d.insertInto('coupons').values(row('c@example.com', 'C')).returning('id'),
        updateReturning: () => d.updateTable('coupons').set({ note: 'x' }).returningAll(),
        deleteReturning: () => d.deleteFrom('coupons').returningAll(),
        onConflict: () => d.insertInto('coupons').values(row('c@example.com', 'C')).onConflict((conflict: any) => conflict.doNothing()),
        merge: () => d.mergeInto('coupons').using('slots', 'slots.slug', 'coupons.code').whenMatched().thenDelete(),
      };
    };

    it.each(['returning', 'updateReturning', 'deleteReturning', 'onConflict', 'merge'] as const)('refuses %s with D29 while compiling, so nothing is sent', (name) => {
      const build = builders(connections)[name];
      expect(() => build().compile()).toThrow(UnsupportedDriverError);
      expect(() => build().compile()).toThrow(/\[marmeon:D29\].*docs\/queries\.md#writing-on-mysql/);
    });

    it('refuses an insert with returning when it is executed, and writes nothing', async () => {
      await expect(builders(connections).returning().execute()).rejects.toThrow(UnsupportedDriverError);
      expect(await count(connections, 'coupons')).toBe(0);
    });

    it('compiles the same builders on SQLite', () => {
      for (const build of Object.values(builders(sqlite.connections))) expect(() => build().compile()).not.toThrow();
    });
  });

  describe('insert()', () => {
    it('returns the stored row with its defaults and the generated id', async () => {
      const users = new Users(connections);
      const user = await users.insert({ name: 'Ada', email: 'ada@example.com' });
      expect(user).toMatchObject({ name: 'Ada', email: 'ada@example.com', is_admin: false, balance: '0.00' });
      expect(user.id).toBeTruthy();
      expect(await users.find(user.id)).toEqual(user);
    });

    it('returns each row by its own id when the other values are equal, and the row with the id it was given, not the highest', async () => {
      const users = new Users(connections);
      const first = await users.insert({ name: 'Same', email: 'same1@example.com' });
      const second = await users.insert({ name: 'Same', email: 'same2@example.com' });
      expect(first.id).not.toBe(second.id);
      expect(await users.find(first.id)).toEqual(first);
      expect(await users.find(second.id)).toEqual(second);
      expect((await users.insert({ id: 500, name: 'High', email: 'high@example.com' } as never)).id).toBe(500);
      expect(await users.insert({ id: 100, name: 'Low', email: 'low@example.com' } as never)).toMatchObject({ id: 100, name: 'Low' });
    });

    it('returns the generated row for an id of 0 or null, which MySQL replaces', async () => {
      const users = new Users(connections);
      const zero = await users.insert({ id: 0, name: 'Zero', email: 'zero@example.com' } as never);
      expect(zero).toMatchObject({ name: 'Zero' });
      expect(zero.id).toBeGreaterThan(0);
      const none = await users.insert({ id: null, name: 'Null', email: 'null@example.com' } as never);
      expect(none).toMatchObject({ name: 'Null' });
      expect(none.id).toBeGreaterThan(zero.id);
    });

    it('refuses an id that an expression of the statement replaced, and writes nothing', async () => {
      const users = new Users(connections);
      const before = await count(connections, 'users');
      const error = await failure(() => users.insert({ id: 600, name: sql`last_insert_id(7)`, email: 'expr@example.com' } as never));
      expect((error as Error).message).toMatch(/not the one it was given/);
      expect(await count(connections, 'users')).toBe(before);
    });

    it('returns a row with deleted_at set: the written row is not filtered', async () => {
      const gone = await coupons.insert(row('gone@example.com', 'GONE', { deleted_at: new Date('2026-01-01T00:00:00Z') }) as never);
      expect(gone.deleted_at).not.toBeNull();
      expect(gone.email).toBe('gone@example.com');
    });

    it('returns no secret column', async () => {
      const user = await new Users(connections).insert({ name: 'Key owner', email: 'keys@example.com' });
      const key = await new ApiKeys(connections).insert({ user_id: user.id, name: 'cli', token: 'secret-token' });
      expect(Object.keys(key).sort()).toEqual(['id', 'name', 'user_id']);
      const stored = await coupons.insert(row('pin@example.com', 'PIN', { pin: '1234' }) as never);
      expect(Object.keys(stored).sort()).toEqual(['code', 'created_at', 'deleted_at', 'email', 'id', 'note', 'updated_at']);
    });
  });

  describe('a UUIDv7 key', () => {
    it('is drawn by the repository in the layout of the column default, and read back', async () => {
      const teams = new Teams(connections);
      const before = Date.now();
      const team = await teams.insert({ name: 'Core' });
      const after = Date.now();
      expect(team.id).toMatch(V7);
      const stored = (await sql<{ id: string }>`select id from teams where name = 'Core'`.execute(db())).rows;
      expect(stored).toEqual([{ id: team.id }]);
      const at = Number.parseInt(team.id.slice(0, 8) + team.id.slice(9, 13), 16);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(after);
    });

    it('is the id the row was given when it has one', async () => {
      const id = '01900000-0000-7000-8000-000000000001';
      expect(await new Teams(connections).insert({ id, name: 'Given' } as never)).toEqual({ id, name: 'Given' });
    });
  });

  describe('a table whose row cannot be read back', () => {
    it('refuses an insert with a key column nothing generates, before anything is sent', async () => {
      const { error, sent } = await attempt(connections, () => slots.insert({ seats: 3 } as never));
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect((error as Error).message).toMatch(/\[marmeon:D29\].*slug.*docs\/queries\.md#writing-on-mysql/);
      expect(sent).toEqual([]);
    });

    it('refuses a key set to an expression, before anything is sent', async () => {
      const inserted = await attempt(connections, () => slots.insert({ slug: sql`'x'` } as never));
      expect(inserted.error).toBeInstanceOf(UnsupportedDriverError);
      expect(inserted.sent).toEqual([]);
      await db().insertInto('slots').values({ slug: 'exists' }).execute();
      // The key check comes before the UPDATE: the row exists, so a check after it would have changed it.
      const updated = await attempt(connections, () => slots.update('exists' as never, { slug: sql`'y'`, seats: 9 } as never));
      expect(updated.error).toBeInstanceOf(UnsupportedDriverError);
      expect(updated.sent).toEqual([]);
      expect(await db().selectFrom('slots').select(['slug', 'seats']).where('slug', '=', 'exists').execute()).toEqual([{ slug: 'exists', seats: 0 }]);
    });

    it('refuses an id that is not empty, 0 or a plain positive whole number, and a key column named in another case, before anything is sent', async () => {
      const users = new Users(connections);
      for (const id of ['0600', '-600', true, 600.4, '600.0', ' 600', '0']) {
        const { error, sent } = await attempt(connections, () => users.insert({ id, name: sql`last_insert_id(7)`, email: 'plain@example.com' } as never));
        expect(error, String(id)).toBeInstanceOf(UnsupportedDriverError);
        expect(sent).toEqual([]);
      }
      // `İd` (U+0130) is `id` to MySQL's case folding and not to JavaScript's: any name outside ASCII must be a column of the table.
      for (const name of ['ID', 'İd', 'Id']) {
        const { error, sent } = await attempt(connections, () => users.insert({ [name]: 600, name: sql`last_insert_id(1)`, email: 'plain@example.com' } as never));
        expect(error, name).toBeInstanceOf(UnsupportedDriverError);
        expect((error as Error).message).toMatch(name === 'İd' ? /no column named "İd"/ : new RegExp(`name it as ${name}`));
        expect(sent).toEqual([]);
      }
    });

    it.each(['insertMany with returning', 'tryInsertMany with returning', 'insertMissing', 'relation().create()', 'a factory'] as const)('refuses %s with D29 and sends no statement of its own', async (name) => {
      const user = await new Users(connections).insert({ name: 'Owner', email: `${name.replaceAll(/\W/g, '')}@example.com` });
      const works = {
        'insertMany with returning': () => coupons.insertMany([row('m1@example.com', 'M1')], { returning: ['id'] }),
        'tryInsertMany with returning': () => coupons.tryInsertMany([row('m2@example.com', 'M2')], { returning: ['id'] } as never),
        insertMissing: () => coupons.insertMissing([row('m3@example.com', 'M3')], { on: ['email'] }),
        'relation().create()': () => (new Users(connections) as any).relation(user.id, 'articles').create({ title: 'T' }),
        'a factory': () => new Factories(connections).for(UserFactory).create(),
      };
      const before = await count(connections, 'coupons');
      const { error, sent } = await attempt(connections, works[name]);
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect((error as Error).message).toContain('[marmeon:D29]');
      // Only the transaction's own statements: the compiler refuses the write itself.
      // A relation write first locks the owner's row with a select.
      const lock = name === 'relation().create()' ? /^select .* for update$/is : /^$/;
      expect(sent.filter((statement) => !/^(begin|commit|savepoint|release|rollback)/i.test(statement) && !lock.test(statement))).toEqual([]);
      expect(await count(connections, 'coupons')).toBe(before);
    });

    it('refuses a key that matches more than one row, and the insert does not commit, not even with an outer transaction that commits', async () => {
      await db().deleteFrom('slots').execute();
      await db().insertInto('slots').values({ slug: '05' }).execute();
      const error = await failure(() => slots.insert({ slug: 5 } as never));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/found 2 rows of slots by its primary key.*rolled back/);
      expect((error as Error).message).not.toContain("'05'");
      await connections.transaction(async () => {
        expect(await failure(() => slots.insert({ slug: 5 } as never))).toBeInstanceOf(Error);
      });
      expect((await db().selectFrom('slots').select('slug').orderBy('slug').execute()).map((r: { slug: string }) => r.slug)).toEqual(['05']);
    });
  });

  describe('a connection that does not manage the schema', () => {
    let plain: { connections: Connections; close: () => Promise<void> };
    interface PlainTables {
      role_user: { role_id: number; user_id: number };
      audit_lines: { line: string };
      items: { id: Generated<number>; name: string };
    }
    class RoleUser extends Repository<'role_user', PlainTables> {
      static table = 'role_user' as const;
    }
    class AuditLines extends Repository<'audit_lines', PlainTables> {
      static table = 'audit_lines' as const;
    }
    class Items extends Repository<'items', PlainTables> {
      static table = 'items' as const;
    }
    beforeAll(async () => {
      plain = await freshConnections('mysql', { managed: false });
      const d = plain.connections.get<any>();
      await sql`create table role_user (role_id int not null, user_id int not null, primary key (role_id, user_id))`.execute(d);
      await sql`create table audit_lines (line varchar(40) not null)`.execute(d);
      await sql`create table items (id bigint not null auto_increment primary key, name varchar(40) not null)`.execute(d);
    }, 30_000);
    afterAll(() => plain.close());

    it('returns a row of a composite key that it was given in full', async () => {
      expect(await new RoleUser(plain.connections).insert({ role_id: 1, user_id: 2 })).toEqual({ role_id: 1, user_id: 2 });
    });

    it('refuses a table without a primary key before it writes', async () => {
      const error = await failure(() => new AuditLines(plain.connections).insert({ line: 'one' }));
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect((error as Error).message).toContain('[marmeon:D29]');
      expect(await count(plain.connections, 'audit_lines')).toBe(0);
    });

    it('refuses an insert without the key value, which it cannot know to be generated, and reads one it was given', async () => {
      const items = new Items(plain.connections);
      const error = await failure(() => items.insert({ name: 'a' }));
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect((error as Error).message).toMatch(/\[marmeon:D29\].*no value for its key column id/);
      expect(await count(plain.connections, 'items')).toBe(0);
      expect(await items.insert({ id: 3, name: 'b' } as never)).toMatchObject({ id: 3, name: 'b' });
    });
  });

  describe('update()', () => {
    it('returns the row when nothing changes', async () => {
      const articles = new Articles(connections);
      const user = await new Users(connections).insert({ name: 'Writer', email: 'writer@example.com' });
      const article = await articles.insert({ user_id: user.id, title: 'Same' });
      expect(await articles.update(article.id, { title: 'Same' })).toEqual(article);
    });

    it('returns undefined for a missing id', async () => {
      expect(await new Articles(connections).update(987_654, { title: 'x' })).toBeUndefined();
    });

    it('returns undefined for a soft-deleted row and leaves it as it was', async () => {
      const gone = await coupons.insert(row('soft@example.com', 'SOFT', { note: 'before', deleted_at: new Date('2026-01-01T00:00:00Z') }) as never);
      expect(await coupons.update(gone.id as never, { note: 'after' })).toBeUndefined();
      const stored = await db().selectFrom('coupons').select('note').where('id', '=', gone.id).executeTakeFirstOrThrow();
      expect(stored.note).toBe('before');
    });

    it('returns the row by its new key when the update changes the key', async () => {
      await slots.insert({ slug: 'a' });
      expect(await slots.update('a' as never, { slug: 'b' })).toEqual({ slug: 'b', seats: 0 });
      expect(await slots.find('a' as never)).toBeUndefined();
    });

    it('compares a UUID key as it is written: the stored case finds the row, another case none', async () => {
      const teams = new Teams(connections);
      const team = await teams.insert({ name: 'Cased' });
      expect(await teams.update(team.id, { name: 'Renamed' })).toEqual({ id: team.id, name: 'Renamed' });
      expect(await teams.update(team.id.toUpperCase(), { name: 'Upper' })).toBeUndefined();
      expect((await db().selectFrom('teams').select('name').where('id', '=', team.id).executeTakeFirstOrThrow()).name).toBe('Renamed');
    });

    it('refuses a key column written in another case in the values, before anything is sent', async () => {
      const users = new Users(connections);
      const user = await users.insert({ name: 'Cased update', email: 'cased@example.com' });
      for (const name of ['ID', 'İD']) {
        const { error, sent } = await attempt(connections, () => users.update(user.id, { [name]: 9, name: 'changed' } as never));
        expect(error, name).toBeInstanceOf(UnsupportedDriverError);
        expect(sent).toEqual([]);
      }
      expect(await users.find(user.id)).toMatchObject({ name: 'Cased update' });
    });

    it('says the key is no longer the written one, not that it matched many rows, when a trigger changed it on insert or update', async () => {
      await sql`create trigger slots_rekey_insert before insert on slots for each row set new.slug = concat(new.slug, 'x')`.execute(db());
      try {
        const error = await failure(() => slots.insert({ slug: 'rk' }));
        expect((error as Error).message).toMatch(/found no row of slots by the key it wrote.*no longer the one it was written with/);
        expect((error as Error).message).not.toMatch(/more than one/);
        expect(await db().selectFrom('slots').select('slug').where('slug', 'like', 'rk%').execute()).toEqual([]);
      } finally {
        await sql`drop trigger slots_rekey_insert`.execute(db());
      }
      await slots.insert({ slug: 'rk2' });
      await sql`create trigger slots_rekey_update before update on slots for each row set new.slug = concat(new.slug, 'x')`.execute(db());
      try {
        const error = await failure(() => slots.update('rk2' as never, { seats: 4 }));
        expect((error as Error).message).toMatch(/found no row of slots by the key it wrote/);
        expect(await db().selectFrom('slots').select(['slug', 'seats']).where('slug', 'like', 'rk2%').execute()).toEqual([{ slug: 'rk2', seats: 0 }]);
      } finally {
        await sql`drop trigger slots_rekey_update`.execute(db());
      }
    });

    it('sends the write, the read and the two ends of the transaction — a savepoint and its release inside one', async () => {
      const users = new Users(connections);
      const verbs = (sent: string[]) => sent.map((statement) => statement.split(' ')[0]!.toLowerCase());
      const outside = await attempt(connections, () => users.insert({ name: 'Counted', email: 'counted@example.com' }));
      expect(outside.error).toBeUndefined();
      expect(verbs(outside.sent)).toEqual(['begin', 'insert', 'select', 'commit']);
      const inside = await attempt(connections, () => connections.transaction(() => users.insert({ name: 'Counted too', email: 'counted2@example.com' })));
      expect(inside.error).toBeUndefined();
      expect(verbs(inside.sent)).toEqual(['begin', 'savepoint', 'insert', 'select', 'release', 'commit']);
    });

    it('refuses to update more than one row and leaves them as they were', async () => {
      // A text key that is no number makes MySQL refuse the comparison with 7 in an update: the other rows go first.
      await db().deleteFrom('slots').execute();
      await db().insertInto('slots').values([{ slug: '7', seats: 1 }, { slug: '07', seats: 1 }]).execute();
      const error = await failure(() => slots.update(7 as never, { seats: 9 }));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/matched 2 rows of slots.*rolled back/);
      expect((await db().selectFrom('slots').select('seats').where('slug', 'in', ['7', '07']).execute()).map((r: { seats: number }) => r.seats)).toEqual([1, 1]);
    });
  });

  describe('tryInsert() and tryUpdate()', () => {
    it('reports the columns of the index a duplicate hit, and none for an index made by raw SQL', async () => {
      await coupons.insert(row('t1@example.com', 'T1', { note: 'raw' }) as never);
      expect(await coupons.tryInsert(row('t1@example.com', 'T2') as never)).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
      expect(await coupons.tryInsert(row('t3@example.com', 'T1') as never)).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['code'] } });
      const stored = await coupons.tryInsert(row('t4@example.com', 'T4') as never);
      expect(stored.ok && stored.value.email).toBe('t4@example.com');
      await sql`create unique index coupons_note_returning on coupons (note)`.execute(db());
      try {
        expect(await coupons.tryInsert(row('t5@example.com', 'T5', { note: 'raw' }) as never)).toEqual({ ok: false, error: { kind: 'duplicate', columns: [] } });
      } finally {
        await sql`drop index coupons_note_returning on coupons`.execute(db());
      }
    });

    it('names the primary key of a duplicate', async () => {
      await slots.insert({ slug: 'k' });
      expect(await slots.tryInsert({ slug: 'k' })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['slug'] } });
    });

    it('leaves a surrounding transaction usable after a duplicate', async () => {
      await coupons.insert(row('u1@example.com', 'U1') as never);
      await connections.transaction(async () => {
        expect((await coupons.tryInsert(row('u1@example.com', 'U2') as never)).ok).toBe(false);
        expect((await coupons.tryInsert(row('u3@example.com', 'U3') as never)).ok).toBe(true);
      });
      expect(await db().selectFrom('coupons').select('id').where('email', '=', 'u3@example.com').execute()).toHaveLength(1);
    });

    it('tryUpdate() answers a duplicate, a missing row and a success', async () => {
      const first = await coupons.insert(row('v1@example.com', 'V1') as never);
      const second = await coupons.insert(row('v2@example.com', 'V2') as never);
      expect(await coupons.tryUpdate(second.id as never, { email: 'v1@example.com' })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
      expect(await coupons.tryUpdate(987_654 as never, { note: 'x' })).toEqual({ ok: false, error: { kind: 'missing' } });
      const updated = await coupons.tryUpdate(first.id as never, { note: 'done' });
      expect(updated.ok && updated.value).toMatchObject({ id: first.id, note: 'done' });
    });
  });
});
