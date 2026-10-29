import type { Application, ModuleDefinition } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drivers, freshConnections, typeGenerator } from './__fixtures__/databases.ts';
import { MigrateCommand, MigrateFreshCommand } from './commands/migrate.ts';
import { Migrator, type Connections } from './index.ts';
import type { Seeding } from './seeders.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const auth: ModuleDefinition = { name: 'auth', migrations: fixtures('auth') };
const root = workspaceTempDir('marmeon-migrate-relations-');

function setup(connections: Connections, driver: 'sqlite' | 'pgsql', fixture: string) {
  const app = { modules: [auth, { name: 'files', migrations: fixtures(fixture) }], root, container: { has: () => false } } as unknown as Application;
  const migrator = new Migrator(app, connections);
  const generator = typeGenerator(app, driver);
  return { migrator, migrate: new MigrateCommand(migrator, generator), fresh: new MigrateFreshCommand(migrator, generator, {} as Seeding) };
}

function input(options: CommandInput['options']) {
  const printed: string[] = [];
  const say = (kind: string) => (text: string) => void printed.push(`${kind}: ${text}`);
  const output = { line: say('line'), info: say('info'), success: say('success'), warn: say('warn'), error: say('error'), table: () => {} };
  return { printed, input: { args: [], options: { force: true, ...options }, output, root } as unknown as CommandInput };
}

afterEach(() => vi.unstubAllEnvs());

describe.each(drivers)('migrate and relations that clash, before anything runs (%s)', (driver) => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });
  const tablesOf = async (connections: Connections) => (await connections.get<any>().introspection.getTables()).map((t: { name: string }) => t.name);

  it('in development refuses a foreign key without _id with D26 and the cure, and applies nothing', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const fresh = await freshConnections(driver);
    close = fresh.close;
    const { migrator, migrate } = setup(fresh.connections, driver, 'relations-shadowed');
    const { printed, input: command } = input({});
    expect(await migrate.handle(command)).toBe(1);
    const text = printed.join('\n');
    expect(text).toContain('[marmeon:D26]');
    expect(text).toContain('name the column uploaded_by_id');
    expect(text).toContain('Nothing was migrated');
    expect(await tablesOf(fresh.connections)).not.toContain('users');
    expect((await migrator.status()).map((m) => m.batch)).toEqual([undefined, undefined]);
  });

  it('runs on with --no-types, and outside development', async () => {
    const fresh = await freshConnections(driver);
    close = fresh.close;
    vi.stubEnv('NODE_ENV', 'development');
    expect(await setup(fresh.connections, driver, 'relations-shadowed').migrate.handle(input({ 'no-types': true }).input)).toBe(0);
    expect(await tablesOf(fresh.connections)).toContain('uploads');
    await setup(fresh.connections, driver, 'relations-shadowed').migrator.reset();
    vi.stubEnv('NODE_ENV', 'test');
    expect(await setup(fresh.connections, driver, 'relations-shadowed').migrate.handle(input({}).input)).toBe(0);
    expect(await tablesOf(fresh.connections)).toContain('uploads');
  });

  it('lets a foreign key named _id through in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const fresh = await freshConnections(driver);
    close = fresh.close;
    expect(await setup(fresh.connections, driver, 'relations-named').migrate.handle(input({}).input)).toBe(0);
    expect(await tablesOf(fresh.connections)).toContain('uploads');
  });

  it('migrate:fresh refuses before it drops a table', async () => {
    const fresh = await freshConnections(driver);
    close = fresh.close;
    vi.stubEnv('NODE_ENV', 'test');
    await setup(fresh.connections, driver, 'relations-named').migrator.migrate();
    vi.stubEnv('NODE_ENV', 'development');
    const { printed, input: command } = input({});
    expect(await setup(fresh.connections, driver, 'relations-shadowed').fresh.handle(command)).toBe(1);
    expect(printed.join('\n')).toContain('[marmeon:D26]');
    expect(await tablesOf(fresh.connections)).toEqual(expect.arrayContaining(['users', 'uploads']));
  });
});
