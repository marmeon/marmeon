import { join } from 'node:path';
import type { ModuleDefinition } from '@marmeon/core';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { appOf as fakeApp, drivers, freshDatabase, silent } from './__fixtures__/databases.ts';
import type { ConnectionOptions } from './config.ts';
import { Connections, Migrator } from './index.ts';
import { dropAllTables } from './migrations/drop-all.ts';
import { inspectionConnection } from './migrator-connection.ts';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const previous: ModuleDefinition[] = [{ name: 'roster-create', migrations: fixtures('retired-old') }];
const retiring: ModuleDefinition[] = [...previous, { name: 'roster-retire', migrations: fixtures('retired') }];
const dropping: ModuleDefinition[] = [...retiring, { name: 'roster-drop', migrations: fixtures('retired-drop') }];
const root = workspaceTempDir('marmeon-retire-');

// A release retires columns and runs `migrate`; the process of the release before keeps serving, and still reads and writes them.
describe.each(drivers)('a retired column on %s', (driver) => {
  let options: ConnectionOptions;
  let drop: () => Promise<void>;
  const opened: Connections[] = [];
  const processOf = (modules: ModuleDefinition[]) => {
    const connections = new Connections({ connections: { default: options }, root, logger: silent, app: fakeApp(modules, root) });
    opened.push(connections);
    return connections;
  };
  let release: Kysely<any>;
  let before: Kysely<any>;

  beforeAll(async () => {
    ({ options, drop } =
      driver === 'sqlite'
        ? { options: { driver: 'sqlite', database: join(tempDir('marmeon-retire-db-'), 'app.sqlite') }, drop: async () => {} }
        : await freshDatabase(driver));
  });
  beforeEach(async () => {
    const scratch = new Connections({ connections: { default: options }, root, logger: silent });
    opened.push(scratch);
    await dropAllTables(inspectionConnection(scratch), driver);
    const releaseProcess = processOf(retiring);
    await new Migrator(fakeApp(retiring, root), releaseProcess).migrate();
    release = releaseProcess.get<any>();
    before = processOf(previous).get<any>();
  });
  afterAll(async () => {
    for (const connections of opened) await connections.destroy();
    await drop();
  });

  const keys = (rows: readonly object[]) => Object.keys(rows[0]!).sort();

  it('is left out of select-all and returning-all, and the previous release, which still knows it, keeps reading it', async () => {
    const [inserted] = await before.insertInto('members').values({ name: 'ada', slug: 'ada', nickname: 'countess', pin: '1815', badge: 'b1' }).returning('id').execute();
    expect(keys(await release.selectFrom('members').selectAll().execute())).toEqual(['id', 'name', 'slug']);
    expect(keys(await release.insertInto('members').values({ name: 'grace', slug: 'grace' }).returningAll().execute())).toEqual(['id', 'name', 'slug']);
    expect(release.selectFrom('members').selectAll().compile().sql).toBe('select "members"."id", "members"."name", "members"."slug" from "members"');
    // The previous release has not heard of the retirement: its statements still name all columns.
    const row = (await before.selectFrom('members').selectAll().where('id', '=', inserted!.id).execute())[0]!;
    expect(row).toMatchObject({ nickname: 'countess', badge: 'b1' });
    expect(Object.keys(row)).not.toContain('pin');
  });

  it('lets the new release insert without it: the database fills in the default or NULL', async () => {
    // Twice: the fixed default and the NULLs of the retired columns must not collide in an index.
    await release.insertInto('members').values({ name: 'grace', slug: 'grace' }).execute();
    await release.insertInto('members').values({ name: 'alan', slug: 'alan' }).execute();
    const rows = (await sql<{ badge: string; nickname: string | null; pin: string | null }>`select badge, nickname, pin from members order by id`.execute(release)).rows;
    expect(rows).toEqual([1, 2].map(() => ({ badge: 'none', nickname: null, pin: null })));
  });

  it('keeps a retired secret column secret: an explicit read is still refused', async () => {
    await before.insertInto('members').values({ name: 'ada', slug: 'ada', pin: '1815' }).execute();
    await expect(release.selectFrom('members').select('pin').execute()).rejects.toThrow(/\[marmeon:D9\]/);
    await expect(before.selectFrom('members').select('pin').execute()).rejects.toThrow(/\[marmeon:D9\]/);
  });

  it('is accepted by the check after a migration, and not reported as a column no migration made', async () => {
    const scratch = processOf(retiring);
    await dropAllTables(inspectionConnection(scratch), driver);
    const unknown: { tables: readonly string[]; columns: readonly string[] }[] = [];
    await new Migrator(fakeApp(retiring, root), scratch).migrate(undefined, { onUnknown: (_, found) => unknown.push(found) });
    expect(unknown).toEqual([]);
  });

  it('is dropped by a later migration, which runs the DDL and takes the secret mark away', async () => {
    const after = processOf(dropping);
    await new Migrator(fakeApp(dropping, root), after).migrate();
    const members = (await after.get<any>().introspection.getTables()).find((table) => table.name === 'members')!;
    expect(members.columns.map((column) => column.name)).toEqual(['id', 'name', 'badge', 'team_id', 'slug']);
    // `pin` is an ordinary name now: the database says it is not there, and the guard does not.
    const failure = await after.get<any>().selectFrom('members').select('pin').execute().catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/D9/);
  });
});
