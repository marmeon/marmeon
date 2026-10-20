import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { Output, type CommandInput } from 'marmeon';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { MigrateCommand, MigrateResetCommand, MigrateRollbackCommand, MigrateStatusCommand } from './commands/migrate.ts';
import { Migrator, type ChangedMigration, type Connections } from './index.ts';
import { migratorConnection } from './migrator-connection.ts';
import type { TypeGenerator } from './types-gen/generator.ts';

const fixtures = new URL('./__fixtures__/migrations/accounts/', import.meta.url);
const created = '2026_01_05_000000_create_accounts_table';
const added = '2026_01_06_000000_add_recovery_code_to_accounts_table';
const things = '2026_02_01_000000_create_things_table';

afterEach(() => vi.restoreAllMocks());

describe.each(drivers)('a migration that changed after it ran, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let directory: string;
  let module: ModuleDefinition;
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver, { record: false }));
    // The fixtures as files of a directory of their own, importing the package by its path.
    directory = tempDir('marmeon-changed-');
    for (const file of readdirSync(fixtures)) {
      const source = readFileSync(new URL(file, fixtures), 'utf8').replace("'../../../index.ts'", JSON.stringify(new URL('./index.ts', import.meta.url).href));
      writeFileSync(join(directory, file), source);
    }
    module = { name: 'accounts', migrations: directory };
  });
  afterEach(() => close());

  const migrator = () => new Migrator({ modules: [module], root: '/' } as unknown as Application, connections);
  const edit = (name: string, change: (source: string) => string = (source) => `${source}// edited\n`) => {
    const file = join(directory, `${name}.ts`);
    writeFileSync(file, change(readFileSync(file, 'utf8')));
  };
  const setChecksum = (name: string, value: string | null) => sql`update migrations set checksum = ${value} where name = ${name}`.execute(migratorConnection(connections));

  async function capture(work: () => Promise<unknown>) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((text) => (stderr.push(String(text)), true));
    try {
      await work();
      return { stdout: stdout.join(''), stderr: stderr.join('') };
    } finally {
      vi.restoreAllMocks();
    }
  }
  const input = (options: CommandInput['options'] = {}) => ({ args: [], options, output: new Output(), root: '/' }) as unknown as CommandInput;

  it('is named by changed() with the checksum it ran with and the one of the file now', async () => {
    await migrator().migrate();
    expect(await migrator().changed()).toEqual([]);
    const recorded = (await connections.get<any>().selectFrom('migrations').select('checksum').where('name', '=', created).executeTakeFirstOrThrow()).checksum;
    edit(created);
    const [only, ...rest] = await migrator().changed();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ name: created, module: 'accounts', batch: 1, recorded });
    expect(only!.current).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(only!.current).not.toBe(recorded);
  });

  it('prints migrate:status --json as the stored format, and the warning and the advice as text', async () => {
    await migrator().migrate();
    edit(created);
    const command = new MigrateStatusCommand(migrator());
    const expected = JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-migrate-status/v1-changed.json', import.meta.url), 'utf8')) as object;
    const json = await capture(() => command.handle(input({ json: true })));
    expect(JSON.parse(json.stdout)).toEqual(expected);
    const text = await capture(() => command.handle(input()));
    expect(text.stderr).toContain(`${created} changed since it ran in batch 1`);
    expect(text.stdout).toContain('Put the file back and write the change as a new migration');
  });

  it('reports it through onChanged before a new migration runs, and does not run it again', async () => {
    await migrator().migrate();
    edit(created);
    const events: string[] = [];
    writeFileSync(
      join(directory, `${things}.ts`),
      `import { defineMigration } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};\nexport default defineMigration({ up: (schema) => schema.create('things', (table) => table.id()), down: (schema) => schema.drop('things') });\n`,
    );
    const runs = await migrator().migrate((run) => events.push(`ran ${run.name}`), { onChanged: (changed) => events.push(`changed ${changed.map((c) => c.name).join(',')}`) });
    expect(runs.map((run) => run.name)).toEqual([things]);
    expect(events).toEqual([`changed ${created}`, `ran ${things}`]);
  });

  it('reports it with nothing pending, and migrate prints it as a warning with the advice', async () => {
    await migrator().migrate();
    edit(created);
    const seen: ChangedMigration[][] = [];
    expect(await migrator().migrate(undefined, { onChanged: (changed) => seen.push([...changed]) })).toEqual([]);
    expect(seen.map((changed) => changed.map((c) => c.name))).toEqual([[created]]);
    const command = new MigrateCommand(migrator(), { fileFormat: () => 'current' } as unknown as TypeGenerator);
    const printed = await capture(() => command.handle(input({ force: true, 'no-types': true })));
    expect(printed.stderr).toContain(`${created} (accounts) changed since it ran in batch 1.`);
    expect(printed.stdout).toContain('docs/migrations.md#a-migration-that-changed-after-it-ran');
  });

  it('does not warn when only the line endings differ', async () => {
    await migrator().migrate();
    edit(created, (source) => source.replaceAll('\n', '\r\n'));
    expect(await migrator().changed()).toEqual([]);
  });

  it('does not warn for a row without a checksum, and warns for any other value', async () => {
    await migrator().migrate();
    await setChecksum(created, null);
    expect(await migrator().changed()).toEqual([]);
    await setChecksum(created, 'sha256:000');
    const changed = await migrator().changed();
    expect(changed.map((c) => c.name)).toEqual([created]);
    expect(changed[0]!.recorded).toBe('sha256:000');
  });

  it('names a migration neither when it is pending nor when its file is gone', async () => {
    await migrator().migrate();
    await sql`insert into migrations (name, module, batch, checksum) values ('2025_12_31_000000_create_gone_table', 'gone', 1, 'sha256:000')`.execute(migratorConnection(connections));
    writeFileSync(join(directory, `${things}.ts`), 'export default { up() {} };\n');
    expect(await migrator().changed()).toEqual([]);
  });

  it('names a changed target before its down() runs, and no other', async () => {
    await migrator().migrate();
    edit(created);
    const events: string[] = [];
    const onChanged = (changed: readonly ChangedMigration[]) => events.push(`changed ${changed.map((c) => c.name).join(',')}`);
    const onRun = (run: { name: string }) => events.push(`ran ${run.name}`);
    // Both ran in one batch: the last step rolls back the second, which did not change.
    await migrator().rollback({ steps: 1, onChanged }, onRun);
    expect(events).toEqual([`ran ${added}`]);
    await migrator().rollback({ steps: 1, onChanged }, onRun);
    expect(events).toEqual([`ran ${added}`, `changed ${created}`, `ran ${created}`]);
  });

  it('names the changed migrations before a reset, and the commands print them', async () => {
    await migrator().migrate();
    edit(added);
    const rolledBack = await capture(() => new MigrateRollbackCommand(migrator()).handle(input({ force: true })));
    expect(rolledBack.stderr).toContain(`${added} (accounts) changed since it ran in batch 1.`);
    await migrator().migrate();
    edit(created);
    const seen: string[][] = [];
    await migrator().reset(undefined, { onChanged: (changed) => seen.push(changed.map((c) => c.name)) });
    expect(seen).toEqual([[created]]);
    await migrator().migrate();
    edit(created, (source) => `${source}// again\n`);
    const reset = await capture(() => new MigrateResetCommand(migrator()).handle(input({ force: true })));
    expect(reset.stderr).toContain(`${created} (accounts) changed since it ran in batch 1.`);
  });
});
