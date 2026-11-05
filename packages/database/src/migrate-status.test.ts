import { readFileSync } from 'node:fs';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { Output, type CommandInput } from 'marmeon';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratorConnection } from './migrator-connection.ts';
import { drivers, freshConnections, freshDatabase, silent } from './__fixtures__/databases.ts';
import { MigrateStatusCommand } from './commands/migrate.ts';
import { Connections, MigrationStateError, Migrator } from './index.ts';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-migrate-status/v1.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const migrator = (connections: Connections, modules: ModuleDefinition[]) => new Migrator({ modules, root: '/' } as unknown as Application, connections);

async function run(command: MigrateStatusCommand, options: CommandInput['options'] = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => (stderr.push(String(text)), true));
  try {
    const code = await command.handle({ args: [], options, output: new Output(), root: '/' } as unknown as CommandInput);
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    vi.restoreAllMocks();
  }
}

afterEach(() => vi.restoreAllMocks());

describe.each(drivers)('migrate:status --json (%s)', (driver) => {
  const setup = async (modules: ModuleDefinition[]) => {
    const { connections, close } = await freshConnections(driver, { record: false });
    return { connections, close, command: new MigrateStatusCommand(migrator(connections, modules)) };
  };
  const auth = { name: 'auth', migrations: fixtures('auth') };
  const accounts = { name: 'accounts', migrations: fixtures('accounts') };

  it('prints a migration that ran with its batch and one that is pending with null, matching the stored format', async () => {
    const { connections, close, command } = await setup([auth, accounts]);
    try {
      await migrator(connections, [auth]).migrate();
      const { code, stdout } = await run(command, { json: true });
      expect(code).toBe(0);
      expect(stdout.endsWith('\n')).toBe(true);
      const document = JSON.parse(stdout) as { migrations: object[] };
      expect(Object.keys(document)).toEqual(['format', 'migrations', 'warnings']);
      expect(document).toMatchObject(fixture);
      expect(document.migrations.map((m) => Object.keys(m))).toEqual(Array(3).fill(['name', 'module', 'connection', 'batch', 'status']));
    } finally {
      await close();
    }
  });

  it('prints the same migrations as the table, in the same order', async () => {
    const { connections, close, command } = await setup([auth, accounts]);
    try {
      await migrator(connections, [auth]).migrate();
      const names = (fixture.migrations as { name: string }[]).map((m) => m.name);
      const text = (await run(command)).stdout;
      expect(names.map((name) => text.indexOf(name))).toEqual(names.map((name) => text.indexOf(name)).toSorted((a, b) => a - b));
      expect(text).toMatch(/create_users_table\s+auth\s+\[1\] Ran\n/);
      expect(text).toMatch(/create_accounts_table\s+accounts\s+Pending\n/);
    } finally {
      await close();
    }
  });

  it('prints no migrations as an empty list, not as the hint', async () => {
    const { close, command } = await setup([]);
    try {
      const { code, stdout } = await run(command, { json: true });
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ format: 1, migrations: [], warnings: [] });
    } finally {
      await close();
    }
  });

  it('warns of a migration that ran and has no file any more, in JSON and in text', async () => {
    const { connections, close, command } = await setup([auth]);
    try {
      await migrator(connections, [auth]).migrate();
      await sql`insert into migrations (name, module, batch) values ('2025_12_31_000000_create_gone_table', 'gone', 1)`.execute(migratorConnection(connections));
      const missing = JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-migrate-status/v1-missing.json', import.meta.url), 'utf8')) as object;
      const { stdout } = await run(command, { json: true });
      expect(JSON.parse(stdout)).toMatchObject(missing);
      expect(JSON.parse(stdout).migrations).toHaveLength(1);
      expect((await run(command)).stderr).toContain('2025_12_31_000000_create_gone_table ran in batch 1 but no module has its file');
    } finally {
      await close();
    }
  });

  it('writes control characters of a recorded migration name out in the text', async () => {
    const { connections, close, command } = await setup([auth]);
    try {
      await migrator(connections, [auth]).migrate();
      await sql`insert into migrations (name, module, batch) values (${'gone\x1b]52;c;aGk=\x07'}, 'gone', 1)`.execute(migratorConnection(connections));
      const { stderr, stdout } = await run(command);
      expect(stderr).toContain('gone\\u001b]52;c;aGk=\\u0007 ran in batch 1 but no module has its file');
      expect(stderr + stdout).not.toMatch(/[^\P{Cc}\n]/u);
    } finally {
      await close();
    }
  });

  it('writes control characters of a recorded name out in the error of a rollback that has no file to run', async () => {
    const { connections, close } = await setup([auth]);
    try {
      await migrator(connections, [auth]).migrate();
      await sql`insert into migrations (name, module, batch) values (${'gone\x1b]52;c;aGk=\x07'}, ${'mod\x1b[2K'}, 99)`.execute(migratorConnection(connections));
      const error = await migrator(connections, [auth]).rollback().catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('"gone\\u001b]52;c;aGk=\\u0007" (module "mod\\u001b[2K"): its file is gone');
      expect((error as Error).message).not.toMatch(/[^\P{Cc}\n]/u);
    } finally {
      await close();
    }
  });

  it('throws for a record of migrations with other columns, so that the CLI prints nothing on stdout', async () => {
    const { connections, close, command } = await setup([auth, accounts]);
    try {
      await migrator(connections, [auth]).migrate();
      await sql`alter table migrations add column note varchar(64)`.execute(migratorConnection(connections));
      const stdout: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
      await expect(command.handle({ args: [], options: { json: true }, output: new Output(), root: '/' } as unknown as CommandInput)).rejects.toThrow(MigrationStateError);
      await expect(command.handle({ args: [], options: {}, output: new Output(), root: '/' } as unknown as CommandInput)).rejects.toThrow(/\[marmeon:D1\].*note/s);
      expect(stdout).toEqual([]);
    } finally {
      await close();
    }
  });

  it('lists the migrations that did not run, on the database an app of this code would refuse', async () => {
    const { connections, close, command } = await setup([auth, accounts]);
    try {
      await migrator(connections, [auth]).migrate();
      const { code, stdout } = await run(command, { json: true });
      expect(code).toBe(0);
      expect(JSON.parse(stdout).migrations.map((m: { status: string }) => m.status)).toEqual(['ran', 'pending', 'pending']);
    } finally {
      await close();
    }
  });
});

describe.each(drivers)('migrate:status --json on another connection (%s)', (driver) => {
  const auth: ModuleDefinition = { name: 'auth', migrations: fixtures('auth') };
  const system: ModuleDefinition = { name: 'system', migrations: fixtures('system') };
  const other: ModuleDefinition = { name: 'other', migrations: fixtures('other') };
  const connectionFixture = JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-migrate-status/v1-connection.json', import.meta.url), 'utf8')) as object;
  let connections: Connections;
  let drops: (() => Promise<void>)[];
  /** The app's container tells the `system` fixture its connection, like `c.make(CacheConfig).connection`. */
  const on = (...modules: ModuleDefinition[]) => new Migrator({ modules, root: '/', container: { make: () => 'system' } } as unknown as Application, connections);

  beforeAll(async () => {
    const [app, second] = [await freshDatabase(driver), await freshDatabase(driver)];
    drops = [app.drop, second.drop];
    connections = new Connections({ connections: { default: app.options, system: second.options }, root: '/', logger: silent });
    await on(auth, other).migrate();
  });
  afterAll(async () => {
    await connections.destroy();
    for (const drop of drops) await drop();
  });

  it('names the connection of each migration, the record being on default', async () => {
    const { code, stdout } = await run(new MigrateStatusCommand(on(auth, system, other)), { json: true });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(connectionFixture);
  });

  it('shows the CONNECTION column when a migration does not run on default, and not otherwise', async () => {
    const text = (await run(new MigrateStatusCommand(on(auth, system, other)))).stdout;
    expect(text).toMatch(/MIGRATION\s+MODULE\s+CONNECTION\s+BATCH \/ STATUS/);
    expect(text).toMatch(/create_metrics_table\s+other\s+system\s+\[1\] Ran\n/);
    const plain = (await run(new MigrateStatusCommand(on(auth)))).stdout;
    expect(plain).toMatch(/^MIGRATION\s+MODULE\s+BATCH \/ STATUS\n/m);
    expect(plain).not.toContain('CONNECTION');
  });

  it('answers null and a warning for a connection that is not configured, with exit 0', async () => {
    const { code, stdout } = await run(new MigrateStatusCommand(on({ name: 'elsewhere', migrations: fixtures('elsewhere') })), { json: true });
    expect(code).toBe(0);
    const document = JSON.parse(stdout) as { migrations: object[]; warnings: string[] };
    expect(document.migrations).toMatchObject([{ name: '2026_01_09_000000_create_reports_table', connection: null, status: 'pending' }]);
    expect(document.warnings).toContain('2026_01_09_000000_create_reports_table: the connection it runs on is unknown — marmeon migrate says why');
    expect((await run(new MigrateStatusCommand(on({ name: 'elsewhere', migrations: fixtures('elsewhere') })))).stdout).toMatch(/elsewhere\s+\?\s+Pending/);
  });

  it('answers null for a file that throws when it is imported, without the text of the error', async () => {
    const command = new MigrateStatusCommand(on({ name: 'throws', migrations: fixtures('throws-on-import') }));
    const { code, stdout } = await run(command, { json: true });
    expect(code).toBe(0);
    const text = await run(command);
    for (const output of [stdout, text.stdout, text.stderr]) {
      expect(output).not.toContain(['pass', 'word'].join(''));
      expect(output).not.toContain('hunter2');
    }
    const document = JSON.parse(stdout) as { migrations: object[]; warnings: string[] };
    expect(document.migrations).toMatchObject([{ connection: null }]);
    expect(document.warnings).toContain('2026_01_12_000000_create_broken_table: the connection it runs on is unknown — marmeon migrate says why');
  });
});
