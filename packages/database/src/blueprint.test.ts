import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, freshConnections, withMysql } from './__fixtures__/databases.ts';
import { Blueprint, ForeignIdColumn, Migrator, type Connections } from './index.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

const root = workspaceTempDir('marmeon-blueprint-app-');

type Spec = ConstructorParameters<typeof ForeignIdColumn>[0];

/** The table `foreignId(name).constrained(...)` ends up referencing. */
function referenced(name: string, ...args: [] | [string]): string | undefined {
  const spec = { name, type: { sqlite: 'integer', pgsql: 'bigint' }, nullable: false, primary: false, identity: false, unique: false, secret: false } as Spec;
  new ForeignIdColumn(spec).constrained(...args);
  return (spec as { references?: { table: string } }).references?.table;
}

describe('constrained() guesses the table', () => {
  it.each([
    ['user_id', 'users'],
    ['category_id', 'categories'],
    ['key_id', 'keys'],
    ['status_id', 'statuses'],
    ['address_id', 'addresses'],
    ['box_id', 'boxes'],
    ['branch_id', 'branches'],
    ['dish_id', 'dishes'],
  ])('%s → %s', (column, table) => {
    expect(referenced(column)).toBe(table);
  });

  it('takes the table that is named', () => {
    expect(referenced('person_id', 'people')).toBe('people');
    expect(referenced('category_id', 'category')).toBe('category');
  });
});

describe.each(drivers)('a guessed table on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    const modules: ModuleDefinition[] = [{ name: 'plurals', migrations: new URL('./__fixtures__/migrations/plurals/', import.meta.url) }];
    await new Migrator({ modules, root } as unknown as Application, connections).migrate();
  });
  afterAll(() => close());

  it('references the plural table, and the metadata finds the relation', async () => {
    await connections.get<any>().selectFrom('products').select('id').execute(); // loads the metadata
    const relations = connections.metadata().relations;
    expect(relations.get('products')?.get('category')).toMatchObject({ kind: 'belongsTo', table: 'categories', foreignKey: 'category_id' });
    expect(relations.get('categories')?.get('products')).toMatchObject({ kind: 'hasMany', table: 'products' });
  });
});

describe.each(drivers)('UUIDv7 columns on %s', (driver) => {
  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const timeOf = (uuid: string) => Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16);
  let connections: Connections;
  let db: Kysely<any>;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    const modules: ModuleDefinition[] = [{ name: 'uuids', migrations: new URL('./__fixtures__/migrations/uuids/', import.meta.url) }];
    await new Migrator({ modules, root } as unknown as Application, connections).migrate();
    db = connections.get<any>();
  });
  afterAll(() => close());

  it('gives rows without a value a unique version 7 UUID, and the time is the insert time', async () => {
    const before = Date.now();
    const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `team ${i}` }));
    for (let i = 0; i < rows.length; i += 100) await db.insertInto('teams').values(rows.slice(i, i + 100)).execute();
    const ids = (await db.selectFrom('teams').select('id').execute()).map((row: { id: string }) => row.id);
    expect(new Set(ids).size).toBe(1000);
    for (const id of ids) {
      expect(id).toMatch(V7);
      expect(Math.abs(timeOf(id) - before)).toBeLessThan(2000);
    }
  });

  it('counts upwards over time', async () => {
    const first = await db.insertInto('teams').values({ name: 'a' }).returning('id').executeTakeFirstOrThrow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await db.insertInto('teams').values({ name: 'b' }).returning('id').executeTakeFirstOrThrow();
    expect(timeOf(second.id)).toBeGreaterThan(timeOf(first.id));
    expect(second.id > first.id).toBe(true);
  });

  it('fills in a raw insert too, and keeps a value that is given', async () => {
    await sql`insert into teams (name) values ('raw')`.execute(db);
    const raw = await db.selectFrom('teams').select('id').where('name', '=', 'raw').executeTakeFirstOrThrow();
    expect(raw.id).toMatch(V7);
    const given = '0190a000-0000-7000-8000-000000000001';
    await db.insertInto('teams').values({ id: given, name: 'given' }).execute();
    expect((await db.selectFrom('teams').select('id').where('name', '=', 'given').executeTakeFirstOrThrow()).id).toBe(given);
  });

  it('cascades through a foreign UUID', async () => {
    const team = await db.insertInto('teams').values({ name: 'cascade' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('members').values({ team_id: team.id, name: 'm' }).execute();
    expect(await db.selectFrom('members').select('id').where('team_id', '=', team.id).execute()).toHaveLength(1);
    await db.deleteFrom('teams').where('id', '=', team.id).execute();
    expect(await db.selectFrom('members').select('id').where('team_id', '=', team.id).execute()).toHaveLength(0);
    expect(connections.metadata().relations.get('members')?.get('team')).toMatchObject({ kind: 'belongsTo', table: 'teams', foreignKey: 'team_id' });
  });

  it('gives a public key next to an integer key, and refuses a second row with the same one', async () => {
    const profile = await db.insertInto('profiles').values({ name: 'ada' }).returning(['id', 'public_id']).executeTakeFirstOrThrow();
    expect(Number(profile.id)).toBeGreaterThan(0);
    expect(profile.public_id).toMatch(V7);
    await expect(db.insertInto('profiles').values({ public_id: profile.public_id, name: 'twin' }).execute()).rejects.toThrow();
  });

  it('reports the column as a uuid', async () => {
    await db.selectFrom('teams').select('id').execute(); // loads the metadata
    expect(connections.metadata().kinds.get('profiles')?.get('public_id')).toBe('uuid');
  });
});

// MySQL runs in `pnpm test:mysql`, which sets MARMEON_TEST_MYSQL_URL. There is no RETURNING there: the ids are read back with a select.
withMysql('UUIDv7 columns on MySQL', () => {
  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const timeOf = (uuid: string) => Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16);
  let connections: Connections;
  let db: Kysely<any>;
  let close: () => Promise<void>;
  const ids = async (table: string, column = 'id') => (await sql<Record<string, string>>`select ${sql.id(column)} as id from ${sql.table(table)} order by ${sql.id(column)}`.execute(db)).rows.map((row) => row.id!);

  beforeAll(async () => {
    ({ connections, close } = await freshConnections('mysql'));
    const modules: ModuleDefinition[] = [{ name: 'uuids', migrations: new URL('./__fixtures__/migrations/uuids/', import.meta.url) }];
    await new Migrator({ modules, root } as unknown as Application, connections).migrate();
    db = connections.get<any>();
  });
  afterAll(() => close());

  it('gives rows without a value a unique version 7 UUID with the variant bits, and the time is the insert time', async () => {
    const before = Date.now();
    const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `team ${i}` }));
    for (let i = 0; i < rows.length; i += 100) await db.insertInto('teams').values(rows.slice(i, i + 100)).execute();
    const found = await ids('teams');
    expect(new Set(found).size).toBe(1000);
    const variants = new Set<string>();
    for (const id of found) {
      expect(id).toMatch(V7);
      expect(Math.abs(timeOf(id) - before)).toBeLessThan(2000);
      variants.add(id[19]!);
    }
    // All four variant digits turn up in a thousand ids; one that never varied would be a constant.
    expect([...variants].sort()).toEqual(['8', '9', 'a', 'b']);
  });

  it('counts upwards over time', async () => {
    await db.insertInto('teams').values({ name: 'a' }).execute();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await db.insertInto('teams').values({ name: 'b' }).execute();
    const read = async (name: string) => (await sql<{ id: string }>`select id from teams where name = ${name}`.execute(db)).rows[0]!.id;
    const [first, second] = [await read('a'), await read('b')];
    expect(timeOf(second)).toBeGreaterThan(timeOf(first));
    expect(second > first).toBe(true);
  });

  it('fills in a raw insert too, keeps a value that is given, and cascades through a foreign UUID', async () => {
    await sql`insert into teams (name) values ('raw')`.execute(db);
    expect((await sql<{ id: string }>`select id from teams where name = 'raw'`.execute(db)).rows[0]!.id).toMatch(V7);
    const given = '0190a000-0000-7000-8000-000000000001';
    await db.insertInto('teams').values({ id: given, name: 'given' }).execute();
    expect((await sql<{ id: string }>`select id from teams where name = 'given'`.execute(db)).rows[0]!.id).toBe(given);
    await db.insertInto('members').values({ team_id: given, name: 'm' }).execute();
    await db.deleteFrom('teams').where('id', '=', given).execute();
    expect(await ids('members', 'team_id')).toEqual([]);
  });

  it('gives a public key next to an integer key, and refuses a second row with the same one', async () => {
    await db.insertInto('profiles').values({ name: 'ada' }).execute();
    const [profile] = (await sql<{ id: string; public_id: string }>`select id, public_id from profiles`.execute(db)).rows;
    expect(Number(profile!.id)).toBeGreaterThan(0);
    expect(profile!.public_id).toMatch(V7);
    await expect(db.insertInto('profiles').values({ public_id: profile!.public_id, name: 'twin' }).execute()).rejects.toThrow(/duplicate/i);
  });
});

describe('a blueprint keeps its parts to itself', () => {
  it('has no list a migration could write to', () => {
    const table = new Blueprint('notes');
    table.string('title');
    // @ts-expect-error — the columns are not a member of the schema builder
    expect(table.columns).toBeUndefined();
    // @ts-expect-error — nor are the indexes
    expect(table.indexes).toBeUndefined();
  });
});
