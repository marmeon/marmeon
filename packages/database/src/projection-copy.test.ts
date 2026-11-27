import { join } from 'node:path';
import type { ModuleDefinition } from '@marmeon/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appOf, drivers, freshDatabase, silent } from './__fixtures__/databases.ts';
import type { ConnectionOptions } from './config.ts';
import { Connections, MigrationStateError, Migrator, Repository } from './index.ts';
import type { ProjectedTable, SchemaProjection } from './schema/projection.ts';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'accounts', migrations: fixtures('accounts') },
  { name: 'tenancy', migrations: fixtures('tenancy') },
];

class Members extends Repository<'tenant_members', any> {
  static table = 'tenant_members' as const;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Writable<U>[] : Writable<T[K]> };

/** What a caller that casts away `readonly` can do to the object `Migrator.projection()` gave it. */
function tamper(projection: SchemaProjection): void {
  for (const table of projection.tables.values() as Iterable<Writable<ProjectedTable>>) {
    for (const column of table.columns) column.secret = false;
    for (const index of table.indexes) index.columns.splice(0, index.columns.length, 'id');
  }
}

describe.each(drivers)('the projection the migrator hands out is a copy — on %s', (driver) => {
  const drops: (() => Promise<void>)[] = [];
  const opened: Connections[] = [];

  const database = async (): Promise<ConnectionOptions> => {
    const fresh = driver === 'sqlite' ? { options: { driver: 'sqlite' as const, database: join(tempDir('marmeon-projection-copy-db-'), 'app.sqlite') }, drop: async () => {} } : await freshDatabase(driver);
    drops.push(fresh.drop);
    return fresh.options;
  };
  // The cache of the process holds one projection per app root, and what the secret guard derives from it is kept per projection: a test
  // that changes the projection of a root that already served a query would find the guard's facts untouched. Each test gets a root of its own.
  let app = appOf(modules, workspaceTempDir('marmeon-projection-copy-'));
  /** A process of the app: cold, it learns the schema from the migration files (the cache of this process) on its first query. */
  const processOn = (options: ConnectionOptions) => {
    const connections = new Connections({ connections: { default: options }, root: app.root, logger: silent, app });
    opened.push(connections);
    return connections;
  };

  let migrated: ConnectionOptions;
  beforeEach(() => {
    app = appOf(modules, workspaceTempDir('marmeon-projection-copy-'));
  });
  beforeAll(async () => {
    migrated = await database();
    const first = processOn(migrated);
    await new Migrator(app, first).migrate();
    await first.get<any>().insertInto('accounts').values({ email: 'ada@example.com', password: 'hash' }).execute();
  });
  afterAll(async () => {
    for (const connections of opened) await connections.destroy();
    for (const drop of drops) await drop();
  });

  // SQLite reports the columns of a duplicate and no index name, so only Postgres reads them from the projection.
  it.runIf(driver === 'pgsql')('a duplicate still names the columns of its index after the caller changed the projection', async () => {
    tamper(await new Migrator(app, processOn(migrated)).projection());
    const members = processOn(migrated).get<any>();
    await members.insertInto('tenant_members').values({ tenant_id: 1, email: 'ada@example.com' }).execute();
    const result = await new Members(processOn(migrated)).tryInsert({ tenant_id: 1, email: 'ada@example.com' });
    expect(result).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['tenant_id', 'email'] } });
  });

  it('selectAll() still leaves out a secret column after the caller marked it public', async () => {
    tamper(await new Migrator(app, processOn(migrated)).projection());
    const [row] = await processOn(migrated).get<any>().selectFrom('accounts').selectAll().execute();
    expect(row).toMatchObject({ email: 'ada@example.com' });
    expect(row).not.toHaveProperty('password');
  });

  it('selectAll() still leaves out a secret column after the caller deleted its table from the projection', async () => {
    // Only the table goes: its secret flags stay as they are, so the deletion alone is what is tried.
    ((await new Migrator(app, processOn(migrated)).projection()).tables as Map<string, ProjectedTable>).delete('accounts');
    const [row] = await processOn(migrated).get<any>().selectFrom('accounts').selectAll().execute();
    expect(row).not.toHaveProperty('password');
  });

  it('an unmigrated database still gives MigrationStateError D2 after the caller emptied the list of migrations', async () => {
    const projection = await new Migrator(app, processOn(migrated)).projection();
    (projection.migrations as unknown[]).length = 0;
    const unmigrated = await database();
    const error = await processOn(unmigrated).get<any>().selectFrom('accounts').select('id').execute().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationStateError);
    expect((error as Error).message).toMatch(/^\[marmeon:D2\]/);
  });
});
