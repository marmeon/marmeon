import { createApplication } from '@marmeon/core';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, type Resolver } from '@marmeon/core';
import type { Migration } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { MakeNotificationsTableCommand, NOTIFICATIONS_MIGRATION } from './commands.ts';
import { NotificationConfig } from './config.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

// The console builds the command through the container, which injects the application.
const application = await createApplication({ root: import.meta.dirname, modules: [], discover: false }, { phase: 'build' });
const command = () => application.container.make(MakeNotificationsTableCommand);

function app(): string {
  const root = tempDir('marmeon-notifications-table-');
  mkdirSync(join(root, 'bootstrap'));
  writeFileSync(
    join(root, 'bootstrap/app.ts'),
    "import { defineApplication } from '@marmeon/core';\nimport auth from '#modules/auth';\n\nexport default defineApplication({ root: '', modules: [auth] });\n",
  );
  return root;
}

function run(root: string, options: Record<string, string> = {}) {
  const lines: string[] = [];
  const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
  return { lines, input: { root, args: [], options, output, spawn: async () => 0 } as never };
}

describe('make:notifications-table', () => {
  it('writes a migration that runs on NOTIFICATIONS_CONNECTION — where the database channel looks', async () => {
    const { default: migration } = (await import(NOTIFICATIONS_MIGRATION.href)) as { default: Migration };
    const on = async (env: Record<string, string>) => {
      const config = (await resolveConfig([NotificationConfig], env)).get(NotificationConfig);
      const container = { make: () => config } as unknown as Resolver;
      return typeof migration.connection === 'function' ? migration.connection(container) : (migration.connection ?? 'default');
    };
    expect(await on({ NOTIFICATIONS_CONNECTION: 'inbox' })).toBe('inbox');
    expect(await on({})).toBe('default');
  });

  it('writes the migration into a new system module, registers the module, and refuses a second one', async () => {
    const root = app();
    const first = run(root);
    expect(await command().handle(first.input)).toBe(0);
    const migration = readdirSync(join(root, 'modules/system/migrations')).find((file) => file.endsWith('_create_notifications_table.ts'))!;
    expect(migration).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_notifications_table\.ts$/);
    // Exactly the file the package's own tests migrate with — what apps get is what is tested.
    expect(readFileSync(join(root, 'modules/system/migrations', migration), 'utf8')).toBe(readFileSync(NOTIFICATIONS_MIGRATION, 'utf8'));
    expect(readFileSync(join(root, 'modules/system/index.ts'), 'utf8')).toContain("migrations: new URL('./migrations/', import.meta.url)");
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8')).toContain("import system from '#modules/system';");
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8')).toContain('modules: [auth, system]');
    expect(first.lines).toEqual([
      '✓ Created modules/system/index.ts',
      `✓ Created modules/system/migrations/${migration}`,
      '✓ Registered the module in bootstrap/app.ts',
      'Then: marmeon migrate',
    ]);

    const again = run(root, { module: 'inbox' });
    expect(await command().handle(again.input)).toBe(0);
    expect(again.lines).toEqual([`modules/system/migrations/${migration} is there — skipped`, '✓ Nothing to publish — every migration of @marmeon/notifications is in your app']);
    expect(existsSync(join(root, 'modules/inbox'))).toBe(false);
  });

  it('takes --module=<name> to a module of its own, and refuses a name that leaves modules/', async () => {
    const root = app();
    expect(await command().handle(run(root, { module: '../x' }).input)).toBe(1);
    expect(existsSync(join(root, 'modules'))).toBe(false);
    expect(await command().handle(run(root, { module: 'inbox' }).input)).toBe(0);
    expect(readdirSync(join(root, 'modules/inbox/migrations'))).toHaveLength(1);
  });
});
