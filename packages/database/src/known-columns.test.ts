import { join } from 'node:path';
import type { ModuleDefinition } from '@marmeon/core';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appOf as fakeApp, drivers, freshConnections, freshDatabase, silent } from './__fixtures__/databases.ts';
import { inspectionConnection } from './books.ts';
import type { ConnectionOptions } from './config.ts';
import { Connections, Migrator, Repository } from './index.ts';
import { dropAllTables } from './migrations/drop-all.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const older: ModuleDefinition[] = [{ name: 'lockers', migrations: fixtures('known-columns-old') }];
const newer: ModuleDefinition[] = [{ name: 'lockers', migrations: fixtures('known-columns') }];
const root = tempDir('marmeon-known-columns-');

class Lockers extends Repository<'lockers', any> {
  static table = 'lockers' as const;
}

// The release that added `recovery_secret` (a secret column) runs `migrate`; a process of the release before it keeps serving until
// it is replaced. It has never heard of the column, so it must not hand it out.
describe.each(drivers)('selectAll() and returningAll() spell out the columns the migrations know, on %s', (driver) => {
  let options: ConnectionOptions;
  let drop: () => Promise<void>;
  const opened: Connections[] = [];
  const processOf = (modules: ModuleDefinition[]) => {
    const connections = new Connections({ connections: { default: options }, root, logger: silent, app: fakeApp(modules, root) });
    opened.push(connections);
    return connections;
  };
  let deploying: Connections;
  let db: Kysely<any>;
  let ahead: Kysely<any>;

  beforeAll(async () => {
    ({ options, drop } =
      driver === 'sqlite'
        ? { options: { driver: 'sqlite', database: join(tempDir('marmeon-known-columns-db-'), 'app.sqlite') }, drop: async () => {} }
        : await freshDatabase(driver));
  });
  beforeEach(async () => {
    const scratch = new Connections({ connections: { default: options }, root, logger: silent });
    opened.push(scratch);
    await dropAllTables(inspectionConnection(scratch), driver, true);
    const release = processOf(newer);
    await new Migrator(fakeApp(newer, root), release).migrate();
    deploying = processOf(older);
    db = release.get<any>();
    ahead = deploying.get<any>();
    await db.insertInto('lockers').values({ name: 'ada', recovery_secret: 'ROTATE-ME' }).execute();
    const [locker] = await db.selectFrom('lockers').select('id').execute();
    await db.insertInto('items').values({ locker_id: locker!.id, label: 'main' }).execute();
  });
  afterAll(async () => {
    for (const connections of opened) await connections.destroy();
    await drop();
  });

  const keys = (rows: readonly object[]) => Object.keys(rows[0]!).sort();

  it('writes the columns of a table without secrets into the statement — the up-to-date process as well', async () => {
    for (const kysely of [db, ahead]) {
      await kysely.selectFrom('items').selectAll().execute(); // the schema is loaded with the first query
      const { sql: text } = kysely.selectFrom('items').selectAll().compile();
      expect(text).toBe('select "items"."id", "items"."locker_id", "items"."label" from "items"');
    }
  });

  it('never hands out a column its migrations did not describe: select-all, joins, aliases, subqueries and common table expressions', async () => {
    const known = ['id', 'name'];
    expect(keys(await ahead.selectFrom('lockers').selectAll().execute())).toEqual(known);
    expect(keys(await ahead.selectFrom('lockers as v').selectAll('v').execute())).toEqual(known);
    expect(keys(await ahead.selectFrom('lockers').selectAll('lockers').execute())).toEqual(known);
    expect(keys(await ahead.selectFrom(ahead.selectFrom('lockers').selectAll().as('s')).selectAll().execute())).toEqual(known);
    expect(keys(await ahead.with('c', (qb: any) => qb.selectFrom('lockers').selectAll()).selectFrom('c').selectAll().execute())).toEqual(known);
    const joined = await ahead.selectFrom('lockers').innerJoin('items', 'items.locker_id', 'lockers.id').selectAll('lockers').select('items.label').execute();
    expect(keys(joined)).toEqual(['id', 'label', 'name']);
    const both = await ahead.selectFrom('lockers').innerJoin('items', 'items.locker_id', 'lockers.id').selectAll().execute();
    expect(Object.keys(both[0]!)).not.toContain('recovery_secret');
    // A column named in the query is the query's own business.
    expect(await ahead.selectFrom('lockers').select(['name', 'recovery_secret']).execute()).toEqual([{ name: 'ada', recovery_secret: 'ROTATE-ME' }]);
  });

  it('leaves it out of returning-all on insert, update, delete and upsert', async () => {
    const inserted = await ahead.insertInto('lockers').values({ name: 'grace' }).returningAll().execute();
    expect(keys(inserted)).toEqual(['id', 'name']);
    const upserted = await ahead
      .insertInto('lockers')
      .values({ id: inserted[0]!.id, name: 'hopper' })
      .onConflict((oc: any) => oc.column('id').doUpdateSet({ name: 'hopper' }))
      .returningAll()
      .execute();
    expect(upserted).toEqual([{ id: inserted[0]!.id, name: 'hopper' }]);
    expect(keys(await ahead.updateTable('lockers').set({ name: 'turing' }).returningAll().execute())).toEqual(['id', 'name']);
    expect(keys(await ahead.deleteFrom('lockers').returningAll().execute())).toEqual(['id', 'name']);
    expect(await ahead.selectFrom('lockers').selectAll().execute()).toEqual([]);
  });

  it('leaves it out of finders and relations', async () => {
    const lockers = new Lockers(deploying);
    const locker = (await lockers.query().selectAll().execute())[0]!;
    expect(locker).toEqual({ id: expect.anything(), name: 'ada' });
    expect(await lockers.find(locker.id as never)).toEqual(locker);
    const withEntries = await (ahead.selectFrom('lockers').select('name') as any).with('items').execute();
    expect(withEntries).toEqual([{ name: 'ada', items: [{ id: expect.anything(), locker_id: locker.id, label: 'main' }] }]);
    const entry = await (ahead.selectFrom('items').select('label') as any).with('locker').execute();
    expect(entry[0]!.locker).toEqual({ id: locker.id, name: 'ada' });
  });

  it('keeps each process to its own columns when they alternate — what one spells out the other does not reuse', async () => {
    const columns = async (kysely: Kysely<any>) => keys(await kysely.selectFrom('lockers').selectAll().execute());
    expect(await columns(db)).toEqual(['id', 'name', 'nickname']);
    expect(await columns(ahead)).toEqual(['id', 'name']);
    expect(await columns(db)).toEqual(['id', 'name', 'nickname']);
    expect(await columns(ahead)).toEqual(['id', 'name']);
  });

  it('refuses the whole row of a table, which holds the columns the process does not know', async () => {
    const asJson = (kysely: Kysely<any>) => kysely.selectFrom('lockers').select((eb: any) => eb.fn('json_object', [eb.table('lockers')]).as('j')).execute();
    await expect(asJson(ahead)).rejects.toThrow(/\[marmeon:D9\].*whole row/);
    if (driver === 'pgsql') {
      await expect(ahead.selectFrom('lockers').select((eb: any) => eb.fn('to_jsonb', [eb.table('lockers')]).as('j')).execute()).rejects.toThrow(/\[marmeon:D9\]/);
      await expect(ahead.selectFrom('lockers').select(sql`to_jsonb(${sql.table('lockers')})`.as('j')).execute()).rejects.toThrow(/\[marmeon:D9\]/);
    }
  });

  it('lets a count of a table through, and tells a column named like its table from the row', async () => {
    await ahead.selectFrom('lockers').selectAll().execute(); // loads the schema, so the guard sees the query when it is compiled
    const counted = ahead.selectFrom('lockers').innerJoin('items', 'items.locker_id', 'lockers.id').select((eb: any) => eb.fn.countAll('items').as('n'));
    if (driver === 'pgsql') expect(await counted.execute()).toEqual([{ n: 1 }]);
    else expect(counted.compile().sql).toContain('count("items".*)');
    await expect(ahead.selectFrom('status').select((eb: any) => eb.fn('json_object', [eb.table('status')]).as('j')).execute()).rejects.toThrow(/\[marmeon:D9\]/);
    expect(await ahead.selectFrom('status').select('status').execute()).toEqual([]);
  });

  it('spells out a table in a schema of the app, and leaves the catalogs alone', async () => {
    if (driver === 'pgsql') {
      expect(keys(await ahead.selectFrom('public.lockers').selectAll().execute())).toEqual(['id', 'name']);
      await ahead.selectFrom('lockers').selectAll().execute();
      expect(ahead.selectFrom('public.lockers').selectAll().compile().sql).toBe('select "lockers"."id", "lockers"."name" from "public"."lockers"');
      expect(ahead.selectFrom('pg_catalog.pg_tables').selectAll().compile().sql).toBe('select * from "pg_catalog"."pg_tables"');
      // A catalog's table is not the migrations' table of the same name.
      expect(ahead.selectFrom('information_schema.lockers').selectAll().compile().sql).toBe('select * from "information_schema"."lockers"');
    } else {
      expect(keys(await ahead.selectFrom('main.lockers').selectAll().execute())).toEqual(['id', 'name']);
    }
  });

  it('leaves a connection that is not managed as it is', async () => {
    const { connections, close } = await freshConnections(driver, { managed: false });
    try {
      const kysely = connections.get<any>();
      await sql`create table lockers (id integer primary key, name text)`.execute(kysely);
      await kysely.selectFrom('lockers').selectAll().execute();
      expect(kysely.selectFrom('lockers').selectAll().compile().sql).toBe('select * from "lockers"');
    } finally {
      await close();
    }
  });

  it('keeps the column secret in the process that knows it', async () => {
    expect(keys(await db.selectFrom('lockers').selectAll().execute())).toEqual(['id', 'name', 'nickname']);
    await expect(db.selectFrom('lockers').select('recovery_secret').execute()).rejects.toThrow(/\[marmeon:D9\]/);
  });

  it('leaves a table no migration created as it is — nothing is known about it to enforce', async () => {
    await sql`create table legacy (id integer primary key, note text)`.execute(ahead);
    await sql`insert into legacy (id, note) values (1, 'kept')`.execute(ahead);
    expect(await ahead.selectFrom('legacy').selectAll().execute()).toEqual([{ id: 1, note: 'kept' }]);
    expect(await ahead.insertInto('legacy').values({ id: 2, note: 'also' }).returningAll().execute()).toEqual([{ id: 2, note: 'also' }]);
    expect((await sql`select 1`.execute(ahead)).rows).toHaveLength(1);
    expect(ahead.selectFrom('legacy').selectAll().compile().sql).toBe('select * from "legacy"');
  });

  it('leaves the catalogs alone', async () => {
    const catalog = driver === 'sqlite' ? 'sqlite_master' : 'pg_catalog.pg_tables';
    const rows = await ahead.selectFrom(catalog).selectAll().execute();
    expect(rows.length).toBeGreaterThan(0);
  });
});
