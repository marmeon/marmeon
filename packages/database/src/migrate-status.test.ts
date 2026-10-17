import { readFileSync } from 'node:fs';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { Output, type CommandInput } from 'marmeon';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migratorConnection } from './migrator-connection.ts';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { MigrateStatusCommand } from './commands/migrate.ts';
import { MigrationStateError, Migrator, type Connections } from './index.ts';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-migrate-status/v1.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const migrator = (connections: Connections, modules: ModuleDefinition[]) => new Migrator({ modules, root: '/' } as unknown as Application, connections);

async function run(command: MigrateStatusCommand, options: CommandInput['options'] = {}) {
  const stdout: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
  try {
    const code = await command.handle({ args: [], options, output: new Output(), root: '/' } as unknown as CommandInput);
    return { code, stdout: stdout.join('') };
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
      expect(document.migrations.map((m) => Object.keys(m))).toEqual(Array(3).fill(['name', 'module', 'batch', 'status']));
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
      const stderr: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((text) => (stderr.push(String(text)), true));
      await run(command);
      expect(stderr.join('')).toContain('2025_12_31_000000_create_gone_table ran in batch 1 but no module has its file');
    } finally {
      await close();
    }
  });

  it('throws for a record of migrations with other columns, so that the CLI prints nothing on stdout', async () => {
    const { connections, close, command } = await setup([auth, accounts]);
    try {
      await migrator(connections, [auth]).migrate();
      await sql`alter table migrations add column checksum varchar(64)`.execute(migratorConnection(connections));
      const stdout: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
      await expect(command.handle({ args: [], options: { json: true }, output: new Output(), root: '/' } as unknown as CommandInput)).rejects.toThrow(MigrationStateError);
      await expect(command.handle({ args: [], options: {}, output: new Output(), root: '/' } as unknown as CommandInput)).rejects.toThrow(/\[marmeon:D1\].*checksum/s);
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
