import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql, type Generated } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { freshConnections, withMysql } from './__fixtures__/databases.ts';
import { ArticleFactory, define } from './__fixtures__/factories.ts';
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
  memberships: { id: Generated<number>; team_id: number; email: string; badge: string | null };
}

class Coupons extends Repository<'coupons', WriteTables> {
  static table = 'coupons' as const;
}
class Slots extends Repository<'slots', WriteTables> {
  static table = 'slots' as const;
}
class Memberships extends Repository<'memberships', WriteTables> {
  static table = 'memberships' as const;
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
/**
 * A statement that changes data or opens a transaction: what a refusal must not send. Reads are not counted: a refusal may read the
 * schema (the catalog, once) or, for a duplicate, the table, to decide.
 */
const isWrite = (query: string) => /^\s*(insert|update|delete|begin|savepoint|start)/i.test(query);
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
      texts: { slug: string };
    }
    class RoleUser extends Repository<'role_user', PlainTables> {
      static table = 'role_user' as const;
    }
    class AuditLines extends Repository<'audit_lines', PlainTables> {
      static table = 'audit_lines' as const;
    }
    class Texts extends Repository<'texts', PlainTables> {
      static table = 'texts' as const;
    }
    class Items extends Repository<'items', PlainTables> {
      static table = 'items' as const;
    }
    beforeAll(async () => {
      plain = await freshConnections('mysql', { managed: false });
      const d = plain.connections.get<any>();
      await sql`create table role_user (role_id int not null, user_id int not null, primary key (role_id, user_id))`.execute(d);
      await sql`create table audit_lines (line varchar(40) not null)`.execute(d);
      await sql`create table texts (slug varchar(40) not null primary key)`.execute(d);
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
    it('refuses insertMany() with returning on a table without a primary key before it writes', async () => {
      const { error, sent } = await attempt(plain.connections, () => new AuditLines(plain.connections).insertMany([{ line: 'a' }, { line: 'b' }], { returning: ['line'] }));
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect(sent.filter(isWrite)).toEqual([]);
      expect(await count(plain.connections, 'audit_lines')).toBe(0);
    });

    it('refuses insertMissing() on a primary key it cannot tell from an auto-increment one when the value is no positive whole number', async () => {
      const text = /primary key column that Marmeon cannot tell from an auto-increment one on a connection with managed: false.*pass a positive whole number, or match on a migration-managed connection/;
      const texts = await attempt(plain.connections, () => new Texts(plain.connections).insertMissing([{ slug: 'a' }], { on: ['slug'] }));
      expect(texts.error).toBeInstanceOf(TypeError);
      expect((texts.error as Error).message).toMatch(text);
      expect(texts.sent.filter(isWrite)).toEqual([]);
      const zero = await attempt(plain.connections, () => new Items(plain.connections).insertMissing([{ id: 0, name: 'z' }], { on: ['id'] }));
      expect(zero.error).toBeInstanceOf(TypeError);
      expect((zero.error as Error).message).toMatch(text);
      expect(zero.sent.filter(isWrite)).toEqual([]);
      expect(await count(plain.connections, 'texts')).toBe(0);
    });

    it('refuses insertMissing() on a column other than the primary key before it sends anything, and matches on the primary key', async () => {
      const items = new Items(plain.connections);
      const before = await count(plain.connections, 'items');
      const { error, sent } = await attempt(plain.connections, () => items.insertMissing([{ id: 20, name: 'm1' }], { on: ['name'] }));
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect((error as Error).message).toMatch(/\[marmeon:D29\].*managed: false.*primary key/);
      expect(sent.filter(isWrite)).toEqual([]);
      expect(await count(plain.connections, 'items')).toBe(before);
      expect(await items.insertMissing([{ id: 21, name: 'm2' }, { id: 21, name: 'm3' }], { on: ['id'] })).toBe(1);
      expect(await items.insertMissing([{ id: 21, name: 'm4' }, { id: 22, name: 'm5' }], { on: ['id'], returning: ['id', 'name'] })).toEqual([{ id: 22, name: 'm5' }]);
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

  describe('insertMany(), tryInsertMany() and insertMissing()', () => {
    const fresh = (tag: string, n: number) => Array.from({ length: n }, (_, i) => row(`${tag}-${i}@example.com`, `${tag.toUpperCase()}-${i}`));
    const emails = async (tag: string) => (await db().selectFrom('coupons').select('email').where('email', 'like', `${tag}-%`).execute()).length;

    it('insertMany() returns the rows in input order with their ids', async () => {
      const rows = await coupons.insertMany(fresh('many', 3), { returning: ['id', 'email'] });
      expect(rows.map((r) => r.email)).toEqual(['many-0@example.com', 'many-1@example.com', 'many-2@example.com']);
      expect(new Set(rows.map((r) => r.id)).size).toBe(3);
      expect(Object.keys(rows[0]!).sort()).toEqual(['email', 'id']);
      for (const written of rows) expect((await coupons.find(written.id as never))?.email).toBe(written.email);
    });

    it('insertMany() with a duplicate in the third row writes none of the rows before it', async () => {
      await coupons.insert(row('dup3-taken@example.com', 'DUP3-TAKEN') as never);
      const rows = [...fresh('dup3', 2), row('dup3-taken@example.com', 'DUP3-NEW')];
      await expect(coupons.insertMany(rows, { returning: ['id'] })).rejects.toMatchObject({ errno: 1062 });
      expect(await emails('dup3')).toBe(1); // the taken row only
      expect(await coupons.insertMany(rows.slice(0, 2))).toBe(2);
    });

    it('insertMany() with returning runs the key checks of insert() on every row, before anything is sent', async () => {
      const users = new Users(connections);
      const before = await count(connections, 'users');
      const rows = [{ id: 1, name: 'A', email: 'chk1@example.com' }, { id: '0600', name: 'B', email: 'chk2@example.com' }];
      const { error, sent } = await attempt(connections, () => users.insertMany(rows as never, { returning: ['id'] }));
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect(sent.filter(isWrite)).toEqual([]);
      const spelled = await failure(() => users.insertMany([{ İd: 1, name: 'A', email: 'chk3@example.com' }, { İd: 2, name: 'B', email: 'chk4@example.com' }] as never, { returning: ['id'] }));
      expect(spelled).toBeInstanceOf(UnsupportedDriverError);
      expect(await count(connections, 'users')).toBe(before);
    });

    it('tryInsertMany() answers the duplicate with its columns, writes nothing and leaves a surrounding transaction usable', async () => {
      await coupons.insert(row('try-taken@example.com', 'TRY-TAKEN') as never);
      const rows = [...fresh('try', 2), row('try-taken@example.com', 'TRY-NEW')];
      expect(await coupons.tryInsertMany(rows, { returning: ['id'] })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
      expect(await emails('try')).toBe(1); // the taken row only
      await connections.transaction(async () => {
        expect((await coupons.tryInsertMany(rows, { returning: ['id'] })).ok).toBe(false);
        expect((await coupons.tryInsertMany(fresh('tryok', 2), { returning: ['id'] })).ok).toBe(true);
      });
      expect(await emails('tryok')).toBe(2);
      expect(await emails('try')).toBe(1); // the savepoint of the failed call was rolled back, not committed with the outer transaction
    });

    it('insertMissing() skips an existing email, writes the new rows and returns only them', async () => {
      await coupons.insert(row('miss-0@example.com', 'MISS-OLD') as never);
      const written = await coupons.insertMissing(fresh('miss', 3), { on: ['email'], returning: ['email'] });
      expect(written.map((r) => r.email).sort()).toEqual(['miss-1@example.com', 'miss-2@example.com']);
      expect(await coupons.insertMissing(fresh('miss', 3), { on: ['email'] })).toBe(0);
      expect(await coupons.insertMissing([row('same@example.com', 'SAME-1'), row('same@example.com', 'SAME-2')], { on: ['email'] })).toBe(1);
    });

    it('insertMissing() on the primary key skips a duplicate of it', async () => {
      expect(await slots.insertMissing([{ slug: 'pk-a' }, { slug: 'pk-a' }, { slug: 'pk-b' }], { on: ['slug'] })).toBe(2);
    });

    it('insertMissing() throws and writes nothing for a duplicate on another index', async () => {
      await coupons.insert(row('other-old@example.com', 'OTHER-C') as never);
      const rows = [row('other-1@example.com', 'OTHER-1'), row('other-new@example.com', 'OTHER-C')];
      await expect(coupons.insertMissing(rows, { on: ['email'] })).rejects.toMatchObject({ errno: 1062 });
      await expect(coupons.insertMissing(rows, { on: ['email'], returning: ['id'] })).rejects.toMatchObject({ errno: 1062 });
      expect(await emails('other')).toBe(1);
    });

    it('insertMissing() is not fooled by a value that imitates the key name of another index', async () => {
      await coupons.insert(row('craft-old@example.com', "x' for key 'coupons.coupons_email_unique") as never);
      const rows = [row('craft-1@example.com', 'CRAFT-1'), row('craft-new@example.com', "x' for key 'coupons.coupons_email_unique")];
      await expect(coupons.insertMissing(rows, { on: ['email'] })).rejects.toMatchObject({ errno: 1062 });
      expect(await emails('craft')).toBe(1);
    });

    it('insertMissing() does not take an index whose name only begins like the one over on', async () => {
      await sql`create unique index coupons_email_uniquex on coupons (note)`.execute(db());
      try {
        await coupons.insert(row('look-old@example.com', 'LOOK-OLD', { note: 'look-note' }) as never);
        const rows = [row('look-1@example.com', 'LOOK-1', { note: 'look-free' }), row('look-new@example.com', 'LOOK-NEW', { note: 'look-note' })];
        await expect(coupons.insertMissing(rows, { on: ['email'] })).rejects.toMatchObject({ errno: 1062 });
        expect(await emails('look')).toBe(1);
      } finally {
        await sql`drop index coupons_email_uniquex on coupons`.execute(db());
      }
    });

    it('insertMissing() skips a row that is there already when MySQL names another index first', async () => {
      const users = new Users(connections);
      const rows = [{ id: 9001, name: 'Id one', email: 'idrun-1@example.com' }, { id: 9002, name: 'Id two', email: 'idrun-2@example.com' }];
      expect(await users.insertMissing(rows as never, { on: ['email'] })).toBe(2);
      expect(await users.insertMissing(rows as never, { on: ['email'] })).toBe(0);
      expect(await users.insertMissing(rows as never, { on: ['email'], returning: ['id'] })).toEqual([]);
      const both = fresh('idboth', 2);
      expect(await coupons.insertMissing(both, { on: ['code'] })).toBe(2);
      expect(await coupons.insertMissing(both, { on: ['code'] })).toBe(0);
      expect(await coupons.insertMissing([...both, row('idboth-new@example.com', 'IDBOTH-NEW')], { on: ['code'] })).toBe(1);
    });

    it('insertMissing() does not skip a row whose on value only matches loosely, and throws the duplicate', async () => {
      const memberships = new Memberships(connections);
      await memberships.insert({ team_id: 7, email: 'loose@example.com', badge: '05' });
      // The pair of team and email clashes first; the badge 5 is `'05'` only to MySQL's comparison, never exactly.
      await expect(memberships.insertMissing([{ team_id: 7, email: 'loose@example.com', badge: 5 as never }], { on: ['badge'] })).rejects.toMatchObject({ errno: 1062 });
      expect(await memberships.insertMissing([{ team_id: 7, email: 'loose@example.com', badge: '05' }], { on: ['badge'] })).toBe(0);
    });

    it('insertMissing() skips only a duplicate of the table it writes, not one raised by a trigger in another', async () => {
      await sql`create trigger slots_into_memberships after insert on slots for each row insert into memberships (id, team_id, email) values (4242, 1, 'trigger')`.execute(db());
      try {
        await expect(slots.insertMissing([{ slug: 't1' }, { slug: 't2' }], { on: ['slug'] })).rejects.toMatchObject({ errno: 1062 });
        expect(await db().selectFrom('slots').select('slug').where('slug', 'in', ['t1', 't2']).execute()).toEqual([]);
      } finally {
        await sql`drop trigger slots_into_memberships`.execute(db());
      }
    });

    it('insertMissing() takes an index over exactly the on columns, in any order, and one with a name of its own', async () => {
      const memberships = new Memberships(connections);
      const pair = [{ team_id: 3, email: 'pair@example.com' }];
      expect(await memberships.insertMissing(pair, { on: ['email', 'team_id'] })).toBe(1);
      expect(await memberships.insertMissing(pair, { on: ['email', 'team_id'] })).toBe(0);
      await expect(memberships.insertMissing(pair, { on: ['email'] })).rejects.toThrow(/found no unique index on memberships \(email\)/);
      const badge = [{ team_id: 4, email: 'badge@example.com', badge: 'B-1' }];
      expect(await memberships.insertMissing(badge, { on: ['badge'] })).toBe(1);
      expect(await memberships.insertMissing(badge, { on: ['badge'] })).toBe(0);
    });

    it('insertMissing() binds the exact text, so a number finds the one stored row among look-alikes', async () => {
      const memberships = new Memberships(connections);
      await memberships.insertMany([{ team_id: 100, email: 'lim-a', badge: '00005' }, { team_id: 101, email: 'lim-b', badge: '0005' }, { team_id: 102, email: 'lim2', badge: '5' }]);
      expect(await memberships.insertMissing([{ team_id: 102, email: 'lim2', badge: 5 as never }], { on: ['badge'] })).toBe(0);
    });

    it('insertMissing() skips a boolean for a stored 1, and never a number that has no exact text', async () => {
      const memberships = new Memberships(connections);
      await memberships.insertMany([{ team_id: 110, email: 'bool', badge: '1' }, { team_id: 111, email: 'frac', badge: '0.5' }, { team_id: 112, email: 'big', badge: String(2 ** 53) }]);
      expect(await memberships.insertMissing([{ team_id: 110, email: 'bool', badge: true as never }], { on: ['badge'] })).toBe(0);
      await expect(memberships.insertMissing([{ team_id: 111, email: 'frac', badge: 0.5 as never }], { on: ['badge'] })).rejects.toMatchObject({ errno: 1062 });
      await expect(memberships.insertMissing([{ team_id: 112, email: 'big', badge: 2 ** 53 as never }], { on: ['badge'] })).rejects.toMatchObject({ errno: 1062 });
    });

    it('insertMissing() lets the error of its own read through, with the duplicate as its cause', async () => {
      await coupons.insert(row('readfail-old@example.com', 'READFAIL-OLD') as never);
      const stop = connections.onQuery((query) => {
        if (/for share/i.test(query.sql)) throw Object.assign(new Error('Deadlock found when trying to get lock'), { errno: 1213 });
      });
      try {
        const error = await failure(() => coupons.insertMissing([row('readfail-old@example.com', 'READFAIL-NEW')], { on: ['code'] }));
        expect(error).toMatchObject({ errno: 1213 });
        expect((error as Error).cause).toMatchObject({ errno: 1062 });
      } finally {
        stop();
      }
    });

    it('insertMissing() does not skip a duplicate that a trigger raised in another table, for a row that is here', async () => {
      await coupons.insert(row('trg-old@example.com', 'TRG-OLD') as never);
      await db().insertInto('memberships').values({ id: 4300, team_id: 5, email: 'trg2' }).execute();
      await sql`create trigger coupons_trigger_clash before insert on coupons for each row insert into memberships (id, team_id, email) values (4300, 6, 'trg3')`.execute(db());
      try {
        await expect(coupons.insertMissing([row('trg-old@example.com', 'TRG-OLD')], { on: ['email'] })).rejects.toMatchObject({ errno: 1062 });
      } finally {
        await sql`drop trigger coupons_trigger_clash`.execute(db());
        await db().deleteFrom('memberships').where('id', '=', 4300).execute();
      }
    });

    it('insertMissing() is not turned into a TypeError by an error whose text quotes the SQLite refusal', async () => {
      // MySQL cuts a duplicate's value short, so the text reaches an error another way: a trigger's own message.
      const text = 'ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint';
      await sql`create trigger coupons_quote before insert on coupons for each row begin if new.code = 'QUOTE' then signal sqlstate '45000' set message_text = ${sql.lit(text)}; end if; end`.execute(db());
      try {
        const error = await failure(() => coupons.insertMissing([row('quote@example.com', 'QUOTE')], { on: ['email'] }));
        expect(error).not.toBeInstanceOf(TypeError);
        expect((error as Error).message).toContain(text);
      } finally {
        await sql`drop trigger coupons_quote`.execute(db());
      }
    });

    it.each([0, 0n, '0', false, 0.4, '', '5x'])('insertMissing() refuses the id %s in an auto-increment on column, and writes nothing on either run', async (id) => {
      const users = new Users(connections);
      const before = await count(connections, 'users');
      const rows = [{ id, name: 'Zero', email: 'zero-on@example.com' }];
      for (let run = 0; run < 2; run++) {
        const { error, sent } = await attempt(connections, () => users.insertMissing(rows as never, { on: ['id'] }));
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toMatch(/auto-increment column on MySQL/);
        expect(sent.filter(isWrite)).toEqual([]);
      }
      expect(await count(connections, 'users')).toBe(before);
    });

    it('insertMissing() keeps a skipped duplicate and a later write in one surrounding transaction', async () => {
      await coupons.insert(row('keep-old@example.com', 'KEEP-OLD') as never);
      await connections.transaction(async () => {
        expect(await coupons.insertMissing([row('keep-old@example.com', 'KEEP-OLD'), row('keep-new@example.com', 'KEEP-NEW')], { on: ['email'] })).toBe(1);
        await coupons.insert(row('keep-later@example.com', 'KEEP-LATER') as never);
      });
      expect(await emails('keep')).toBe(3);
    });

    it('insertMissing() throws its TypeError for columns no unique index backs, before a statement', async () => {
      const { error, sent } = await attempt(connections, () => coupons.insertMissing([row('t@example.com', 'T', { note: 'n' })], { on: ['note'] }));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(/found no unique index on coupons \(note\)/);
      expect(sent.filter(isWrite)).toEqual([]);
    });
  });
});

interface RelationTables extends FixtureTables {
  tags: { id: Generated<number>; slug: string };
  post_tag: { post_id: number; tag_id: number };
}
class Posts extends Repository<'posts', RelationTables> {
  static table = 'posts' as const;
}
class Tags extends Repository<'tags', RelationTables> {
  static table = 'tags' as const;
}
class Shelves extends Repository<'shelves', any> {
  static table = 'shelves' as const;
}

withMysql('creating rows through factories and relations on MySQL', () => {
  let connections: Connections;
  let close: () => Promise<void>;
  let plain: { connections: Connections; close: () => Promise<void> };
  let factories: Factories;
  let posts: Posts;
  let tags: Tags;
  let users: Users;
  let author = 0;
  const relationRoot = workspaceTempDir('marmeon-mysql-relations-app-');
  const relationModules: ModuleDefinition[] = [
    { name: 'auth', migrations: dir('auth') },
    { name: 'blog', migrations: dir('blog') },
    { name: 'relations', migrations: dir('relations') },
    { name: 'relations-secrets', migrations: dir('relations-secrets') },
    { name: 'mysql-writes', migrations: dir('mysql-writes') },
    { name: 'mysql-relations', migrations: dir('mysql-relations') },
  ];
  const db = () => connections.get<any>();
  const pivot = async (post: number) => (await db().selectFrom('post_tag').select('tag_id').where('post_id', '=', post).orderBy('tag_id').execute()).map((link: { tag_id: number }) => link.tag_id);
  const slug = (note: { slug: string }) => note.slug;
  const threadOf = async (conn: Connections) => Number((await sql<{ id: string }>`select connection_id() as id`.execute(conn.get<any>())).rows[0]!.id);
  // A lock wait is read from performance_schema: information_schema.innodb_trx can show a waiting transaction as running.
  const waiting = async (thread: number) =>
    Number(
      (
        await sql<{ n: string }>`select count(*) as n from performance_schema.data_lock_waits w join performance_schema.threads t on t.thread_id = w.requesting_thread_id where t.processlist_id = ${sql.lit(thread)}`.execute(db())
      ).rows[0]!.n,
    ) > 0;

  // DDL on the shared Docker host is slow.
  beforeAll(async () => {
    ({ connections, close } = await freshConnections('mysql'));
    await new Migrator({ modules: relationModules, root: relationRoot } as unknown as Application, connections).migrate();
    factories = new Factories(connections);
    posts = new Posts(connections);
    tags = new Tags(connections);
    users = new Users(connections);
    author = (await users.insert({ name: 'Author', email: 'author@example.com' })).id;
    plain = await freshConnections('mysql', { managed: false });
    await sql`create table audit_lines (line varchar(40) not null)`.execute(plain.connections.get<any>());
    await sql`create table parents (id varchar(40) not null primary key)`.execute(plain.connections.get<any>());
  }, 60_000);
  afterAll(async () => {
    await close();
    await plain.close();
  });

  describe('a factory', () => {
    it('creates a row with the row of its related factory, both with their ids', async () => {
      const article = await factories.for(ArticleFactory).create();
      expect(article.id).toBeGreaterThan(0);
      const writer = await users.find(article.user_id);
      expect(writer?.email).toMatch(/^user\d+@example\.com$/);
      expect(await new Articles(connections).find(article.id)).toEqual(article);
    });

    it('creates rows inside connections.transaction(), and a rollback takes them away', async () => {
      const before = await count(connections, 'articles');
      await connections.transaction(async () => {
        const rows = await factories.for(ArticleFactory).count(2).create();
        expect(rows.map((created) => created.id).every((id) => id > 0)).toBe(true);
        expect(await count(connections, 'articles')).toBe(before + 2);
      });
      expect(await count(connections, 'articles')).toBe(before + 2);
      await expect(
        connections.transaction(async () => {
          await factories.for(ArticleFactory).create();
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await count(connections, 'articles')).toBe(before + 2);
    });

    it('creates rows inside the driver’s isolate(), which is undone with it', async () => {
      const before = await count(connections, 'articles');
      const isolation = await connections.isolate();
      try {
        const article = await factories.for(ArticleFactory).create();
        expect(await new Articles(connections).find(article.id)).toEqual(article);
        expect(await count(connections, 'articles')).toBe(before + 1);
      } finally {
        await isolation.rollback();
      }
      expect(await count(connections, 'articles')).toBe(before);
    });

    it('takes back a row whose read-back failed, also when the transaction around it commits', async () => {
      // The number 5 matches the text '05' too, so the read-back finds two rows: the insert of '5' has to be undone with it.
      const Loose = define('slots' as never, () => ({ slug: 5 }) as never);
      await db().insertInto('slots').values({ slug: '05' }).execute();
      await connections.transaction(async () => {
        const error = await failure(() => factories.for(Loose as never).create());
        expect((error as Error).message).toMatch(/found 2 rows of slots by its primary key.*rolled back/);
        await factories.for(ArticleFactory).create();
      });
      expect((await db().selectFrom('slots').select('slug').orderBy('slug').execute()).map((slot: { slug: string }) => slot.slug)).toEqual(['05']);
      const alone = await failure(() => factories.for(Loose as never).create());
      expect(alone).toBeInstanceOf(Error);
      expect((await db().selectFrom('slots').select('slug').orderBy('slug').execute()).map((slot: { slug: string }) => slot.slug)).toEqual(['05']);
    });

    it('refuses a table without a primary key with D29 before it creates the rows it relates to, and writes nothing', async () => {
      // The related parent would be created and committed first if the refusal came after it.
      const Parent = define('parents' as never, ({ sequence }) => ({ id: `p${sequence}` }) as never);
      const Lines = define('audit_lines' as never, ({ factory }) => ({ line: 'one', parent_id: factory(Parent as never) }) as never);
      const sent: string[] = [];
      const stop = plain.connections.onQuery((query) => sent.push(query.sql));
      try {
        const error = await failure(() => new Factories(plain.connections).for(Lines as never).count(2).create());
        expect(error).toBeInstanceOf(UnsupportedDriverError);
        expect((error as Error).message).toContain('[marmeon:D29]');
        expect((error as Error).message).toMatch(/primary key/);
      } finally {
        stop();
      }
      expect(sent.filter(isWrite)).toEqual([]);
      expect(await count(plain.connections, 'parents')).toBe(0);
      expect(await count(plain.connections, 'audit_lines')).toBe(0);
    });

    it('takes back a row whose read-back failed inside a transaction it was given, which then commits', async () => {
      const Loose = define('slots' as never, () => ({ slug: 5 }) as never);
      await db().deleteFrom('slots').execute();
      await db().insertInto('slots').values({ slug: '05' }).execute();
      await db().transaction().execute(async (trx) => {
        const error = await failure(() => factories.for(Loose as never).using(trx as never).create());
        expect((error as Error).message).toMatch(/found 2 rows of slots by its primary key.*rolled back/);
      });
      expect((await db().selectFrom('slots').select('slug').orderBy('slug').execute()).map((slot: { slug: string }) => slot.slug)).toEqual(['05']);
    });
  });

  describe('a relation', () => {
    it('createMany() keeps the input order and returns no secret column', async () => {
      const keys = await users.relation(author, 'api_keys').createMany([
        { name: 'b', token: 'token-b' },
        { name: 'a', token: 'token-a' },
        { name: 'c', token: 'token-c' },
      ] as never);
      expect(keys.map((key) => key.name)).toEqual(['b', 'a', 'c']);
      expect(keys.every((key) => key.id > 0 && !('token' in key))).toBe(true);
      expect(new Set(keys.map((key) => key.id)).size).toBe(3);
      const one = await users.relation(author, 'api_keys').create({ name: 'd', token: 'token-d' } as never);
      expect(one).not.toHaveProperty('token');
    });

    it('createMany() refuses a key column written in another case and rolls back the earlier rows', async () => {
      const before = await count(connections, 'api_keys');
      const error = await failure(() => users.relation(author, 'api_keys').createMany([{ name: 'ok', token: 't1' }, { name: 'x', token: 't2', ID: 5 }] as never));
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect((error as Error).message).toContain('[marmeon:D29]');
      expect((error as Error).message).toMatch(/another case|ID/);
      expect(await count(connections, 'api_keys')).toBe(before);
    });

    it('createMany() rolls back the earlier rows when the read-back of a later one finds two rows', async () => {
      const shelf = await new Shelves(connections).insert({ name: 'Notes' });
      await db().insertInto('shelf_notes').values({ slug: '05', shelf_id: shelf.id }).execute();
      const error = await failure(() => (new Shelves(connections) as any).relation(shelf.id, 'shelf_notes').createMany([{ slug: '7' }, { slug: 5 }]));
      expect((error as Error).message).toMatch(/found 2 rows of shelf_notes by its primary key.*rolled back/);
      expect((await db().selectFrom('shelf_notes').select('slug').orderBy('slug').execute()).map((note: { slug: string }) => slug(note))).toEqual(['05']);
    });

    it('create() on a table without a primary key is refused with D29, and nothing is written', async () => {
      const shelf = await new Shelves(connections).insert({ name: 'Marks' });
      const { error, sent } = await attempt(connections, () => (new Shelves(connections) as any).relation(shelf.id, 'shelf_marks').create({ mark: 'm' }));
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect((error as Error).message).toContain('[marmeon:D29]');
      expect((error as Error).message).toMatch(/primary key/);
      expect(sent.filter((statement) => /^\s*insert/i.test(statement))).toEqual([]);
      expect(await count(connections, 'shelf_marks')).toBe(0);
    });

    it('attach() and sync() link one id at a time and answer the ids they linked', async () => {
      const post = await posts.insert({ author_id: author, title: 'Links' });
      const [one, two, three] = [await tags.insert({ slug: 'link-1' }), await tags.insert({ slug: 'link-2' }), await tags.insert({ slug: 'link-3' })];
      const { error, sent } = await attempt(connections, async () => expect(await posts.relation(post.id, 'tags').attach([one.id, two.id])).toEqual([one.id, two.id]));
      expect(error).toBeUndefined();
      // One insert per link, never one statement for all.
      expect(sent.filter((statement) => statement.startsWith('insert into `post_tag`'))).toHaveLength(2);
      expect(await posts.relation(post.id, 'tags').sync([two.id, three.id])).toEqual({ attached: [three.id], detached: [one.id] });
      expect(await pivot(post.id)).toEqual([two.id, three.id]);
    });

    /**
     * A links `tag` to `post` with a raw insert and stays open; B attaches the same link, from a snapshot older than A's commit, so its own read of the
     * links cannot see A's and only the insert meets it. B waits for A's lock, A commits, and B's answer is returned.
     */
    async function attachWhileLinked(
      post: number,
      tag: number,
      { table = 'post_tag', parent = 'post_id', other = 'tag_id', conns = connections, attach = () => posts.relation(post, 'tags').attach([tag]) }: { table?: string; parent?: string; other?: string; conns?: Connections; attach?: () => Promise<unknown[]> } = {},
    ): Promise<unknown[]> {
      let linkedByA!: () => void;
      const aHolds = new Promise<void>((resolve) => (linkedByA = resolve));
      let commitA!: () => void;
      const aMayCommit = new Promise<void>((resolve) => (commitA = resolve));
      const a = conns.transaction(async () => {
        await conns.get<any>().insertInto(table).values({ [parent]: post, [other]: tag }).execute();
        linkedByA();
        await aMayCommit;
      });
      await aHolds;
      let thread = 0;
      let readOnce!: () => void;
      const bRead = new Promise<void>((resolve) => (readOnce = resolve));
      const b = conns.transaction(
        async () => {
          thread = await threadOf(conns);
          await conns.get<any>().selectFrom(table).select(other).where(parent, '=', post).execute();
          readOnce();
          return attach();
        },
        { isolationLevel: 'repeatable read' },
      );
      await bRead;
      await vi.waitFor(async () => expect(await waiting(thread)).toBe(true), { timeout: 10_000, interval: 25 });
      commitA();
      await a;
      return b;
    }

    it('attach() skips the link another transaction made at the same moment, and links once', async () => {
      const post = await posts.insert({ author_id: author, title: 'Race' });
      const tag = await tags.insert({ slug: 'race-9' });
      expect(await attachWhileLinked(post.id, tag.id)).toEqual([]);
      expect(await pivot(post.id)).toEqual([tag.id]);
    });

    it('attach() skips the link that is there already when MySQL names another unique index first', async () => {
      await db().deleteFrom('post_tag').execute();
      const post = await posts.insert({ author_id: author, title: 'Named first' });
      const tag = await tags.insert({ slug: 'first-9' });
      const [pair] = (
        await sql<{ name: string }>`select index_name as name from information_schema.statistics where table_schema = database() and table_name = 'post_tag' and non_unique = 0 group by index_name having count(*) = 2`.execute(db())
      ).rows;
      // The index over one column goes first among the unique ones, so MySQL reports it for a link that breaks both.
      await sql`create unique index post_tag_first on post_tag (post_id)`.execute(db());
      await sql.raw(`alter table post_tag drop index \`${pair!.name}\``).execute(db());
      await sql.raw(`alter table post_tag add unique index \`${pair!.name}\` (post_id, tag_id)`).execute(db());
      try {
        expect(await attachWhileLinked(post.id, tag.id)).toEqual([]);
        expect(await pivot(post.id)).toEqual([tag.id]);
      } finally {
        await sql`drop index post_tag_first on post_tag`.execute(db());
      }
    });

    it('attach() skips nothing when it knows no unique index over the two keys, even for a link that is there', async () => {
      // A connection with managed: false reads no migrations, so it knows no index by name. Another unique index comes first and reports.
      const d = plain.connections.get<any>();
      await sql`create table shelves (id bigint not null auto_increment primary key, name varchar(40) not null)`.execute(d);
      await sql`create table labels (id bigint not null auto_increment primary key, name varchar(40) not null)`.execute(d);
      await sql`create table shelf_label (shelf_id bigint not null, label_id bigint not null, unique key by_label (label_id), unique key by_pair (shelf_id, label_id), foreign key (shelf_id) references shelves (id), foreign key (label_id) references labels (id))`.execute(d);
      const shelf = await sql<any>`insert into shelves (name) values ('s')`.execute(d);
      const label = await sql<any>`insert into labels (name) values ('l')`.execute(d);
      const [shelfId, labelId] = [Number(shelf.insertId), Number(label.insertId)];
      const relation = () => (new Shelves(plain.connections) as any).relation(shelfId, 'labels').attach([labelId]);
      // Without the race the writer would see the link and write nothing: the proof needs the link to appear between its read and its insert.
      const error = await failure(() => attachWhileLinked(shelfId, labelId, { table: 'shelf_label', parent: 'shelf_id', other: 'label_id', conns: plain.connections, attach: relation }));
      expect(error).toMatchObject({ errno: 1062 });
      expect(await count(plain.connections, 'shelf_label')).toBe(1);
    });

    it('attach() throws, and links nothing more, for a duplicate on another unique index of the pivot', async () => {
      const post = await posts.insert({ author_id: author, title: 'Other index' });
      const linked = await tags.insert({ slug: 'linked-tag' });
      const second = await tags.insert({ slug: 'second-tag' });
      const third = await tags.insert({ slug: 'third-tag' });
      await db().insertInto('post_tag').values({ post_id: post.id, tag_id: linked.id }).execute();
      // A post may now have one link only: the pair is new, the duplicate is on this index. Earlier tests' links would break the index.
      await db().deleteFrom('post_tag').where('post_id', '!=', post.id).execute();
      await sql`create unique index post_tag_extra on post_tag (post_id)`.execute(db());
      try {
        await expect(posts.relation(post.id, 'tags').attach([second.id, third.id])).rejects.toMatchObject({ errno: 1062 });
        expect(await pivot(post.id)).toEqual([linked.id]);
        await expect(posts.relation(post.id, 'tags').sync([linked.id, second.id])).rejects.toMatchObject({ errno: 1062 });
        expect(await pivot(post.id)).toEqual([linked.id]);
      } finally {
        await sql`drop index post_tag_extra on post_tag`.execute(db());
      }
    });
  });
});
