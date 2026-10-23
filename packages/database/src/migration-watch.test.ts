import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
/** Latency of the operating system's file events: the wait ends as soon as the event is handled. */
const EVENT = { timeout: 10_000, interval: 25 };
const TEST = { timeout: 15_000 };
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
  /**
   * Waits until a watcher on `directory` has reported a change. The operating system starts a watch stream asynchronously, so a change
   * made right after `watchMigrations` can go unseen; a file that is no migration is written until the reload it causes has happened.
   */
  const armed = async (connections: Connections) => {
    const reload = vi.spyOn(connections.metadata(), 'reload');
    await vi.waitFor(
      () => {
        writeFileSync(join(directory, 'probe.txt'), String(Date.now()));
        expect(reload).toHaveBeenCalled();
      },
      // Well past the watcher's quiet time plus the event's latency, or every write would start that wait over.
      { timeout: 10_000, interval: 250 },
    );
  };
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
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  afterAll(async () => {
    for (const connections of opened) await connections.destroy();
    await drop();
  });

  it('refuses queries when a migration file appears and answers again once migrate ran in another process, with no restart', TEST, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, connections } = processOf();
    const watcher = watchMigrations(app);
    try {
      await expect(select(connections)).resolves.toEqual([]);
      await armed(connections);
      addAccounts();
      await vi.waitFor(async () => expect(await select(connections).catch((e: unknown) => e)).toBeInstanceOf(MigrationStateError), EVENT);
      await expect(select(connections)).rejects.toMatchObject({ reason: 'pending', missing: [ACCOUNTS.replace('.ts', '')] });
      await migrate();
      // The refusal is looked at again within a second: the clock moves past that, no waiting.
      vi.setSystemTime(Date.now() + 1_100);
      await expect(select(connections)).resolves.toEqual([]);
      expect(connections.metadata().kinds.has('accounts')).toBe(true);
    } finally {
      watcher.close();
    }
  });

  it('reads a migration file again when it is changed: the new plan is in memory and in .marmeon/schema.json, not the old one', TEST, async () => {
    const { app, connections } = processOf();
    const watcher = watchMigrations(app);
    try {
      await expect(select(connections)).resolves.toEqual([]);
      expect(connections.metadata().secrets.get('users')?.has('name') ?? false).toBe(false);
      await armed(connections);
      const path = join(directory, USERS);
      writeFileSync(path, readFileSync(path, 'utf8').replace("table.string('name');", "table.string('name').secret();"));
      await vi.waitFor(async () => {
        await select(connections);
        expect(connections.metadata().secrets.get('users')?.has('name')).toBe(true);
      }, EVENT);
      // What a restart would read.
      const stored = readProjection(root, migrationFiles(app));
      expect(stored?.tables.get('users')?.columns.find((column) => column.name === 'name')?.secret).toBe(true);
    } finally {
      watcher.close();
    }
  });

  it('knows a table the moment its migration file is removed and the database keeps it: the app runs on without it', TEST, async () => {
    addAccounts();
    await migrate();
    const { app, connections } = processOf();
    const watcher = watchMigrations(app);
    try {
      await expect(select(connections)).resolves.toEqual([]);
      expect(connections.metadata().kinds.has('accounts')).toBe(true);
      await armed(connections);
      rmSync(join(directory, ACCOUNTS));
      await vi.waitFor(async () => {
        await select(connections);
        expect(connections.metadata().kinds.has('accounts')).toBe(false);
      }, EVENT);
    } finally {
      watcher.close();
    }
  });

  /** A watcher that is on, in its own process: once it has refused a query, the file event reached every watcher on that directory. */
  const control = async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const other = processOf();
    const watcher = watchMigrations(other.app);
    await expect(select(other.connections)).resolves.toEqual([]);
    return {
      watcher,
      arm: () => armed(other.connections),
      seen: () => vi.waitFor(async () => expect(await select(other.connections).catch((e: unknown) => e)).toBeInstanceOf(MigrationStateError), EVENT),
    };
  };

  it('watches nothing outside development, and nothing once closed', TEST, async () => {
    const { app, connections } = processOf();
    await expect(select(connections)).resolves.toEqual([]);
    const first = await control();
    await first.arm();
    vi.stubEnv('NODE_ENV', 'production');
    const production = watchMigrations(app);
    addAccounts();
    // Without the control, a change that arrives late would pass for a watcher that does nothing.
    await first.seen();
    await expect(select(connections)).resolves.toEqual([]);
    production.close();
    first.watcher.close();
    rmSync(join(directory, ACCOUNTS));
    const second = await control();
    watchMigrations(app).close();
    await second.arm();
    addAccounts();
    await second.seen();
    await expect(select(connections)).resolves.toEqual([]);
    second.watcher.close();
  });
});
