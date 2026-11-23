import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConsoleLogger, defineModule, nextMigrationStamp, type ApplicationDefinition, type ModuleDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { CliServiceProvider } from 'marmeon';
import { afterAll, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp } from './index.ts';

// The way to test a migration a generator wrote: the file goes to a directory of its own inside the app, a test app boots with the
// module that owns it next to the app's own, and `migrate` and `migrate:rollback` run through `app.command()`.

const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
const drivers = PGSQL_URL ? (['sqlite', 'pgsql'] as const) : (['sqlite'] as const);

const notes = defineModule({
  name: 'notes',
  migrations: new URL('./__fixtures__/migrations/', import.meta.url),
});

/** What a generator would write: adds a column and fills it for the rows that are there, and takes it away again. */
const addSlug = `import { defineMigration, sql } from '@marmeon/database';

export default defineMigration({
  up: (schema) => {
    schema.alter('notes', (table) => table.string('slug').default(''));
    schema.data(async (db) => {
      await db.updateTable('notes').set({ slug: sql\`'note-' || id\` }).execute();
    });
  },
  down: (schema) => schema.alter('notes', (table) => table.dropColumn('slug')),
});
`;

/** A `down` that fails after the `up` ran. */
const failingDown = `import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) => schema.alter('notes', (table) => table.string('slug').default('')),
  down: () => {
    throw new Error('down refused');
  },
});
`;

/** An `up` that fails. */
const failingUp = `import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: () => {
    throw new Error('up refused');
  },
  down: () => {},
});
`;

/** Writes `source` into a directory of its own below the app and returns the module that owns it. */
function generated(root: string, name: string, source: string): ModuleDefinition {
  // The file imports `@marmeon/database` as it does in an app, where the app's `node_modules` holds it.
  const modules = join(root, 'node_modules');
  if (!existsSync(modules)) symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), modules);
  const directory = join(root, 'storage', 'framework', 'testing', name, 'migrations');
  // A test that asks again gets one file, not two.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  // The stamp sorts behind the migrations in `modules/*/migrations` of the app; this one has none there, so it is the stamp of now.
  writeFileSync(join(directory, `${nextMigrationStamp(root)}_add_slug_to_notes_table.ts`), source);
  return defineModule({ name, migrations: pathToFileURL(`${directory}/`) });
}

describe.each(drivers)('a generated migration on %s', (driver) => {
  const root = workspaceTempDir('marmeon-testing-generated-');
  const made: string[] = [];
  const admin =
    driver === 'pgsql'
      ? new Connections({
          connections: { default: { driver: 'pgsql', url: PGSQL_URL! } },
          root,
          logger: new ConsoleLogger(),
        })
      : undefined;

  /** The environment of a database of its own, one per test: a SQLite file inside the app, or a Postgres database made for the test. */
  const own = async (name: string): Promise<Record<string, string | undefined>> => {
    if (driver === 'sqlite') {
      mkdirSync(join(root, 'storage', 'framework', 'testing'), { recursive: true });
      return { APP_KEY: generateKey(), DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: join(root, 'storage', 'framework', 'testing', `${name}.sqlite`) };
    }
    const database = `marmeon_test_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    made.push(database);
    await sql`create database ${sql.id(database)}`.execute(admin!.get());
    const url = new URL(PGSQL_URL!);
    url.pathname = `/${database}`;
    return { APP_KEY: generateKey(), DB_DRIVER: 'pgsql', DB_URL: url.href };
  };

  const definition = (modules: ModuleDefinition[]): ApplicationDefinition => ({
    root,
    discover: false,
    providers: [EncryptionServiceProvider, DatabaseServiceProvider, CliServiceProvider],
    modules,
  });

  afterAll(async () => {
    if (!admin) return;
    for (const database of made) await sql`drop database if exists ${sql.id(database)} with (force)`.execute(admin.get());
    await admin.destroy();
  });

  it('migrates the rows the app already has through its data step, and rolls the step back', async () => {
    const env = await own('slug');
    const slugs = async (app: Awaited<ReturnType<typeof createTestApp>>) =>
      (await app.make(Connections).get<any>().selectFrom('notes').select(['title', 'slug']).orderBy('id').execute()).map((row: { slug: string }) => row.slug);
    {
      // The app as it is: migrated and holding data the generated migration will meet.
      await using app = await createTestApp(definition([notes]), { env });
      expect((await app.command('migrate')).code).toBe(0);
      await app
        .make(Connections)
        .get<any>()
        .insertInto('notes')
        .values([{ title: 'First' }, { title: 'Second' }])
        .execute();
    }
    const module = generated(root, 'add-slug', addSlug);
    await using app = await createTestApp(definition([notes, module]), { env });
    const up = await app.command('migrate');
    expect(up.code, up.lines.join('\n')).toBe(0);
    expect(await slugs(app)).toEqual(['note-1', 'note-2']);
    const down = await app.command('migrate:rollback', { options: { step: 1 } });
    expect(down.code, down.lines.join('\n')).toBe(0);
    await expect(app.make(Connections).get<any>().selectFrom('notes').select('slug').execute()).rejects.toThrow(/slug/);
    expect(await app.make(Connections).get<any>().selectFrom('notes').select('title').execute()).toHaveLength(2);
  });

  it('answers a failing down with code 1 and the error in lines, without throwing', async () => {
    const module = generated(root, 'failing-down', failingDown);
    await using app = await createTestApp(definition([notes, module]), { env: await own('failing-down') });
    const up = await app.command('migrate');
    expect(up.code, up.lines.join('\n')).toBe(0);
    const down = await app.command('migrate:rollback', { options: { step: 1 } });
    expect(down.code).toBe(1);
    expect(down.lines.join('\n')).toContain('down refused');
  });

  it('answers a failing up with code 1 and the error in lines, without throwing', async () => {
    const module = generated(root, 'failing-up', failingUp);
    await using app = await createTestApp(definition([notes, module]), { env: await own('failing-up') });
    const up = await app.command('migrate');
    expect(up.code).toBe(1);
    expect(up.lines.join('\n')).toContain('up refused');
  });
});

describe.each(drivers)("the worker's database of database: 'refresh' on %s", (driver) => {
  const root = workspaceTempDir('marmeon-testing-generated-refresh-');
  const env = {
    APP_KEY: generateKey(),
    ...(driver === 'pgsql' ? { DB_DRIVER: 'pgsql', DB_URL: PGSQL_URL } : { DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:' }),
  };
  const definition = (modules: ModuleDefinition[]): ApplicationDefinition => ({
    root,
    discover: false,
    providers: [EncryptionServiceProvider, DatabaseServiceProvider, CliServiceProvider],
    modules,
  });
  const slugs = (app: Awaited<ReturnType<typeof createTestApp>>) => app.make(Connections).get<any>().selectFrom('notes').select('slug').execute();

  /** The first app of the worker: it prepares the worker's database with the app's own modules only. */
  const prepare = async () => {
    await using first = await createTestApp(definition([notes]), { env, database: 'refresh' });
    expect(await first.make(Connections).get<any>().selectFrom('notes').select('title').execute()).toEqual([]);
  };

  it('fails with D2 for a generated module that arrives after the worker database was prepared, until migrate ran', async () => {
    await prepare();
    const module = generated(root, 'add-slug', addSlug);
    await using app = await createTestApp(definition([notes, module]), { env, database: 'refresh' });
    await expect(slugs(app)).rejects.toThrow(/marmeon:D2/);
    expect((await app.command('migrate')).code).toBe(0);
    expect(await slugs(app)).toEqual([]);
  });

  it('takes back a migrate of an earlier app: the next app, with or without the generated module, is as before', async () => {
    await prepare();
    const module = generated(root, 'add-slug', addSlug);
    {
      await using app = await createTestApp(definition([notes, module]), { env, database: 'refresh' });
      expect((await app.command('migrate')).code).toBe(0);
      expect(await slugs(app)).toEqual([]);
    }
    {
      await using app = await createTestApp(definition([notes, module]), { env, database: 'refresh' });
      await expect(slugs(app)).rejects.toThrow(/marmeon:D2/);
    }
    {
      // Without the generated module the app has no D2, and the column the migrate added is not there.
      await using app = await createTestApp(definition([notes]), { env, database: 'refresh' });
      await expect(slugs(app)).rejects.toThrow(/slug/);
    }
  });

  it('takes back a rollback of an earlier app too', async () => {
    await prepare();
    const module = generated(root, 'add-slug', addSlug);
    {
      await using app = await createTestApp(definition([notes, module]), { env, database: 'refresh' });
      expect((await app.command('migrate')).code).toBe(0);
      expect((await app.command('migrate:rollback', { options: { step: 1 } })).code).toBe(0);
    }
    await using app = await createTestApp(definition([notes, module]), { env, database: 'refresh' });
    await expect(slugs(app)).rejects.toThrow(/marmeon:D2/);
  });
});
