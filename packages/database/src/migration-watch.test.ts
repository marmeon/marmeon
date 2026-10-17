import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drivers, freshDatabase, silent } from './__fixtures__/databases.ts';
import type { ConnectionOptions } from './config.ts';
import { migrationFiles } from './migrations/files.ts';
import { readProjection } from './schema/projection-file.ts';
import { Connections, MigrationStateError, Migrator } from './index.ts';
import { dropAllTables } from './migrations/drop-all.ts';
import { watchMigrations } from './migrations/watch.ts';
import { inspectionConnection } from './migrator-connection.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const USERS = '2026_01_01_000000_create_users_table.ts';
const ACCOUNTS = '2026_01_05_000000_create_accounts_table.ts';
const database = new URL('./index.ts', import.meta.url).href;

/** A fixture migration copied into the app's directory, importing the package's source (a temporary directory has no node_modules). */
const copy = (name: string, file: string, to: string) =>
  writeFileSync(join(to, file), readFileSync(new URL(`./__fixtures__/migrations/${name}/${file}`, import.meta.url), 'utf8').replace("'../../../index.ts'", `'${database}'`));

describe.each(drivers)('the migration watcher of the development server, on %s', (driver) => {
  let options: ConnectionOptions;
  let drop: () => Promise<void>;
  const opened: Connections[] = [];
  const root = tempDir('marmeon-migration-watch-');
  const directory = join(root, 'migrations');
  const module = { name: 'app', migrations: pathToFileURL(`${directory}/`) } satisfies ModuleDefinition;

  /** A process of the app: its connections read the migration files under `root`. */
  const processOf = () => {
    const connections = new Connections({ connections: { default: options }, root, logger: silent, app: appWith() });
    opened.push(connections);
    const app = appWith(connections);
    return { app, connections };
  };
  const appWith = (connections?: Connections) => ({ modules: [module], root, container: { has: () => false, make: () => connections } }) as unknown as Application;
  const select = (connections: Connections) => connections.get<any>().selectFrom('users').select('id').execute();
  const addAccounts = () => copy('accounts', ACCOUNTS, directory);
  const migrate = async () => {
    const other = processOf();
    await new Migrator(other.app, other.connections).migrate();
  };

  beforeAll(async () => {
    ({ options, drop } =
      driver === 'sqlite'
        ? { options: { driver: 'sqlite', database: join(tempDir('marmeon-migration-watch-db-'), 'app.sqlite') }, drop: async () => {} }
        : await freshDatabase(driver));
  });
  beforeEach(async () => {
    mkdirSync(directory, { recursive: true });
    for (const file of readdirSync(directory)) rmSync(join(directory, file));
    copy('auth', USERS, directory);
    const scratch = new Connections({ connections: { default: options }, root, logger: silent });
    opened.push(scratch);
    await dropAllTables(inspectionConnection(scratch), driver);
    await migrate();
    vi.stubEnv('NODE_ENV', 'development');
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    for (const connections of opened) await connections.destroy();
    await drop();
  });

  it('refuses queries when a migration file appears and answers again once migrate ran in another process, with no restart', async () => {
    const { app, connections } = processOf();
    const watcher = watchMigrations(app);
    try {
      await expect(select(connections)).resolves.toEqual([]);
      addAccounts();
      await vi.waitFor(async () => expect(await select(connections).catch((e: unknown) => e)).toBeInstanceOf(MigrationStateError));
      await expect(select(connections)).rejects.toMatchObject({ reason: 'pending', missing: [ACCOUNTS.replace('.ts', '')] });
      await migrate();
      // The refusal is looked at again within a second.
      await vi.waitFor(async () => expect(await select(connections)).toEqual([]), { timeout: 4000 });
      expect(connections.metadata().kinds.has('accounts')).toBe(true);
    } finally {
      watcher.close();
    }
  });

  it('reads a migration file again when it is changed: the new plan is in memory and in .marmeon/schema.json, not the old one', async () => {
    const { app, connections } = processOf();
    const watcher = watchMigrations(app);
    try {
      await expect(select(connections)).resolves.toEqual([]);
      expect(connections.metadata().secrets.get('users')?.has('name') ?? false).toBe(false);
      const path = join(directory, USERS);
      writeFileSync(path, readFileSync(path, 'utf8').replace("table.string('name');", "table.string('name').secret();"));
      await vi.waitFor(async () => {
        await select(connections);
        expect(connections.metadata().secrets.get('users')?.has('name')).toBe(true);
      });
      // What a restart would read.
      const stored = readProjection(root, migrationFiles(app));
      expect(stored?.tables.get('users')?.columns.find((column) => column.name === 'name')?.secret).toBe(true);
    } finally {
      watcher.close();
    }
  });

  it('knows a table the moment its migration file is removed and the database keeps it: the app runs on without it', async () => {
    addAccounts();
    await migrate();
    const { app, connections } = processOf();
    const watcher = watchMigrations(app);
    try {
      await expect(select(connections)).resolves.toEqual([]);
      expect(connections.metadata().kinds.has('accounts')).toBe(true);
      rmSync(join(directory, ACCOUNTS));
      await vi.waitFor(async () => {
        await select(connections);
        expect(connections.metadata().kinds.has('accounts')).toBe(false);
      });
    } finally {
      watcher.close();
    }
  });

  it('watches nothing outside development, and nothing once closed', async () => {
    const { app, connections } = processOf();
    await expect(select(connections)).resolves.toEqual([]);
    vi.stubEnv('NODE_ENV', 'production');
    const production = watchMigrations(app);
    addAccounts();
    await sleep(500);
    await expect(select(connections)).resolves.toEqual([]);
    production.close();
    rmSync(join(directory, ACCOUNTS));
    vi.stubEnv('NODE_ENV', 'development');
    watchMigrations(app).close();
    addAccounts();
    await sleep(500);
    await expect(select(connections)).resolves.toEqual([]);
  });
});
