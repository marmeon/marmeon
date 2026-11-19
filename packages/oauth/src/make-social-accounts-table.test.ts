import { createApplication } from '@marmeon/core';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { MakeSocialAccountsTableCommand, SOCIAL_ACCOUNTS_MIGRATION } from './make-social-accounts-table.ts';

// The console builds the command through the container, which injects the application.
const application = await createApplication({ root: import.meta.dirname, modules: [], discover: false }, { phase: 'build' });
const command = () => application.container.make(MakeSocialAccountsTableCommand);

/** An app with the dependencies the test names, and what the command prints. */
function app(dependencies: Record<string, string> = {}) {
  const root = workspaceTempDir('marmeon-social-accounts-table-');
  mkdirSync(join(root, 'bootstrap'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies }));
  const lines: string[] = [];
  const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
  const run = (options: Record<string, string> = {}) => ({ root, args: [], options, output, spawn: async () => 0 }) as never;
  return { root, lines, run };
}

describe('make:social-accounts-table', () => {
  it('writes the migration with a fresh timestamp into the system module and writes nothing the second time', { timeout: 60_000 }, async () => {
    const { root, lines, run } = app();
    expect(await command().handle(run()), lines.join('\n')).toBe(0);
    const migration = readdirSync(join(root, 'modules/system/migrations')).find((file) => file.endsWith('_create_social_accounts_table.ts'))!;
    expect(migration).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_social_accounts_table\.ts$/);
    // Not the template's name: it would sort before the migration of `users`.
    expect(migration.startsWith('0001_01_01')).toBe(false);
    expect(readFileSync(join(root, 'modules/system/migrations', migration), 'utf8')).toBe(readFileSync(SOCIAL_ACCOUNTS_MIGRATION, 'utf8'));
    expect(lines).toContain(`✓ Created modules/system/migrations/${migration}`);
    expect(lines).toContain('Then: marmeon migrate');

    lines.length = 0;
    expect(await command().handle(run())).toBe(0);
    expect(lines).toEqual([`modules/system/migrations/${migration} is there — skipped`, '✓ Nothing to publish — every migration of @marmeon/oauth is in your app']);
    expect(readdirSync(join(root, 'modules/system/migrations'))).toEqual([migration]);
  });

  it('writes into an existing system module, leaving its index and the stub record alone, for a package that is a link (workspace:*)', async () => {
    const { root, lines, run } = app({ '@marmeon/oauth': 'workspace:*' });
    mkdirSync(join(root, 'modules/system/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/system/index.ts'), 'export default {};\n');
    const index = readFileSync(join(root, 'modules/system/index.ts'), 'utf8');
    writeFileSync(join(root, 'modules/system/migrations/2026_01_01_000000_create_users_table.ts'), '');
    expect(await command().handle(run()), lines.join('\n')).toBe(0);
    const files = readdirSync(join(root, 'modules/system/migrations'));
    expect(files).toHaveLength(2);
    const migration = files.find((file) => file.endsWith('_create_social_accounts_table.ts'))!;
    // Behind the migration that makes `users`.
    expect([...files].sort().at(-1)).toBe(migration);
    expect(readFileSync(join(root, 'modules/system/index.ts'), 'utf8')).toBe(index);
    // The command of a package does not record what it writes.
    expect(existsSync(join(root, 'marmeon-stubs.json'))).toBe(false);
  });

  it('puts the migration into the module --module names', async () => {
    const { root, lines, run } = app();
    expect(await command().handle(run({ module: 'accounts' })), lines.join('\n')).toBe(0);
    expect(readdirSync(join(root, 'modules/accounts/migrations')).map((file) => file.replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, ''))).toEqual(['create_social_accounts_table.ts']);
    expect(readdirSync(join(root, 'modules'))).toEqual(['accounts']);
  });

  it('adds no copy when another module of the app already has the migration, and creates no system module', async () => {
    const { root, lines, run } = app();
    mkdirSync(join(root, 'modules/auth/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/auth/migrations/2026_01_01_000000_create_social_accounts_table.ts'), '');
    expect(await command().handle(run())).toBe(0);
    expect(lines).toEqual(['modules/auth/migrations/2026_01_01_000000_create_social_accounts_table.ts is there — skipped', '✓ Nothing to publish — every migration of @marmeon/oauth is in your app']);
    expect(existsSync(join(root, 'modules/system'))).toBe(false);
    expect(readdirSync(join(root, 'modules/auth/migrations'))).toEqual(['2026_01_01_000000_create_social_accounts_table.ts']);
  });

  it('writes into the app module --module names, and leaves its index.ts as it is', async () => {
    const { root, lines, run } = app();
    mkdirSync(join(root, 'modules/billing'), { recursive: true });
    const index = "export default { migrations: new URL('./migrations/', import.meta.url) };\n";
    writeFileSync(join(root, 'modules/billing/index.ts'), index);
    expect(await command().handle(run({ module: 'billing' })), lines.join('\n')).toBe(0);
    expect(readdirSync(join(root, 'modules/billing/migrations')).map((file) => file.replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, ''))).toEqual(['create_social_accounts_table.ts']);
    expect(readFileSync(join(root, 'modules/billing/index.ts'), 'utf8')).toBe(index);
    expect(existsSync(join(root, 'modules/system'))).toBe(false);
  });

  it('refuses a module that leaves modules/ and writes nothing', async () => {
    const { root, lines, run } = app();
    expect(await command().handle(run({ module: '../x' }))).toBe(1);
    expect(readdirSync(root).sort()).toEqual(['bootstrap', 'package.json']);
    expect(lines).toEqual(['✗ Pass the module as a kebab-case name: --module=<name>.']);
  });

  it('takes --module and nothing else', () => {
    expect(MakeSocialAccountsTableCommand.options).toEqual({ module: { type: 'string', short: 'm' } });
  });
});
