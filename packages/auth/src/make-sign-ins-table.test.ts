import { createApplication } from '@marmeon/core';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { MakeSignInsTableCommand, SIGN_INS_MIGRATION } from './make-sign-ins-table.ts';

// The console builds the command through the container, which injects the application.
const application = await createApplication({ root: import.meta.dirname, modules: [], discover: false }, { phase: 'build' });
const command = () => application.container.make(MakeSignInsTableCommand);

describe('make:sign-ins-table', () => {
  it('writes the migration into the system module and refuses to write a second one', async () => {
    const root = tempDir('marmeon-sign-ins-table');
    mkdirSync(join(root, 'bootstrap'));
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
    const run = { root, args: [], options: {}, output, spawn: async () => 0 } as never;

    expect(await command().handle(run)).toBe(0);
    const migration = readdirSync(join(root, 'modules/system/migrations')).find((file) => file.endsWith('_create_sign_ins_table.ts'))!;
    expect(migration).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_sign_ins_table\.ts$/);
    expect(readFileSync(join(root, 'modules/system/migrations', migration), 'utf8')).toBe(readFileSync(SIGN_INS_MIGRATION, 'utf8'));
    expect(lines).toContain(`✓ Created modules/system/migrations/${migration}`);

    lines.length = 0;
    expect(await command().handle(run)).toBe(0);
    expect(lines).toEqual([`modules/system/migrations/${migration} is there — skipped`, '✓ Nothing to publish — every migration of @marmeon/auth is in your app']);
    expect(readdirSync(join(root, 'modules/system/migrations'))).toEqual([migration]);
  });

  it('adds no copy when the kit has the table in its auth module, and refuses a module that leaves modules/', async () => {
    const root = tempDir('marmeon-sign-ins-table');
    mkdirSync(join(root, 'modules/auth/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/auth/migrations/2026_01_01_000000_create_sign_ins_table.ts'), '');
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
    const run = (options: Record<string, string>) => ({ root, args: [], options, output, spawn: async () => 0 }) as never;
    expect(await command().handle(run({}))).toBe(0);
    expect(readdirSync(join(root, 'modules'))).toEqual(['auth']);
    expect(await command().handle(run({ module: '../x' }))).toBe(1);
    expect(readdirSync(join(root, 'modules'))).toEqual(['auth']);
    const other = tempDir('marmeon-sign-ins-table');
    expect(await command().handle({ root: other, args: [], options: { module: 'billing' }, output } as never)).toBe(0);
    expect(readdirSync(join(other, 'modules/billing/migrations'))).toHaveLength(1);
  });

  it('the stub is the test fixture, but for its header comment and the foreign key', () => {
    const body = (url: URL) => readFileSync(url, 'utf8').split('\n').filter((line) => !line.startsWith('//') && !line.includes("'user_id'")).join('\n');
    expect(body(SIGN_INS_MIGRATION)).toBe(body(new URL('./__fixtures__/migrations/2026_01_01_000006_create_sign_ins_table.ts', import.meta.url)));
  });

  it('takes --module and nothing else', () => {
    expect(MakeSignInsTableCommand.options).toEqual({ module: { type: 'string', short: 'm' } });
  });
});
