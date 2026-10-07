import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MakeNotificationsTableCommand, NOTIFICATIONS_MIGRATION } from './commands.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

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
  it('writes the migration into a new system module (E96), registers the module, and refuses a second one', async () => {
    const root = app();
    const first = run(root);
    expect(await new MakeNotificationsTableCommand().handle(first.input)).toBe(0);
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
    expect(await new MakeNotificationsTableCommand().handle(again.input)).toBe(1);
    expect(again.lines).toEqual([`✗ modules/system/migrations/${migration} already exists — the notifications table has its migration.`]);
  });
});
