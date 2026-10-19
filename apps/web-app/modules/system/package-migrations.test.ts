import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MakeSignInsTableCommand } from '@marmeon/auth';
import { MakeCacheTableCommand } from '@marmeon/cache';
import { PublishCommand } from '@marmeon/database';
import { MakeNotificationsTableCommand } from '@marmeon/notifications';
import { MakeQueueTableCommand } from '@marmeon/queue';
import { MakeSessionTableCommand } from '@marmeon/session';
import { MakeUploadsTableCommand } from '@marmeon/storage';
import type { CommandInput } from 'marmeon';
import { expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';

// The app shows what `marmeon check` asks of every app: the migrations of the packages it publishes from are in it.
it('has every migration of the packages it uses', async () => {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const code = await new PublishCommand().handle({ root, args: [], options: { check: true }, output } as unknown as CommandInput);
  expect(lines).toEqual(['✓ Every package you publish from has its migrations in your app']);
  expect(code).toBe(0);
});

const MAKE_COMMANDS = [
  ['@marmeon/cache', 'cache', MakeCacheTableCommand],
  ['@marmeon/session', 'session', MakeSessionTableCommand],
  ['@marmeon/queue', 'queue', MakeQueueTableCommand],
  ['@marmeon/notifications', 'notifications', MakeNotificationsTableCommand],
  ['@marmeon/storage', 'storage', MakeUploadsTableCommand],
  ['@marmeon/auth', 'auth', MakeSignInsTableCommand],
] as const;

// A make:*-table command is publish for its own package: both write the same files, into the same module (only the packages of
// the workspace are all here, so the comparison of the six lives in this app).
it.each(MAKE_COMMANDS)('%s: its make command writes the same bytes as publish, to the same path', async (name, directory, Command) => {
  const output = { success: () => {}, warn: () => {}, error: () => {}, line: () => {} };
  const app = (): string => {
    const root = tempDir('marmeon-make-or-publish-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [name]: 'workspace:*' } }));
    mkdirSync(join(root, 'node_modules/@marmeon'), { recursive: true });
    symlinkSync(fileURLToPath(new URL(`../../../../packages/${directory}`, import.meta.url)), join(root, 'node_modules', name));
    return root;
  };
  const published = app();
  const made = app();
  expect(await new PublishCommand().handle({ root: published, args: [name], options: {}, output } as unknown as CommandInput)).toBe(0);
  expect(await new Command().handle({ root: made, args: [], options: {}, output } as unknown as CommandInput)).toBe(0);
  const files = (root: string) => readdirSync(join(root, 'modules'), { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.ts')).sort();
  const stripped = (path: string) => path.replace(/\/\d{4}_\d{2}_\d{2}_\d{6}_/, '/');
  expect(files(made).map(stripped)).toEqual(files(published).map(stripped));
  expect(files(published).length).toBeGreaterThan(1);
  for (const [index, path] of files(published).entries()) {
    expect(readFileSync(join(made, 'modules', files(made)[index]!), 'utf8')).toBe(readFileSync(join(published, 'modules', path), 'utf8'));
  }
  // A second run writes nothing, and ends well.
  expect(await new Command().handle({ root: made, args: [], options: {}, output } as unknown as CommandInput)).toBe(0);
  expect(files(made)).toHaveLength(files(published).length);
});

// In an app that has the tables it ends with 0 and writes nothing, though this app installs the packages by workspace:*.
it.each(MAKE_COMMANDS.map(([name, , Command]) => [name, Command] as const))('has nothing left for the make command of %s', async (name, Command) => {
  const app = tempDir('marmeon-web-app-tables-');
  const source = fileURLToPath(new URL('../..', import.meta.url));
  cpSync(join(source, 'modules'), join(app, 'modules'), { recursive: true });
  cpSync(join(source, 'package.json'), join(app, 'package.json'));
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const code = await new Command().handle({ root: app, args: [], options: {}, output } as unknown as CommandInput);
  expect(lines.filter((line) => !line.endsWith('is there — skipped'))).toEqual([`✓ Nothing to publish — every migration of ${name} is in your app`]);
  expect(code).toBe(0);
});
