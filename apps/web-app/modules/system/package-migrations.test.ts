import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import definition from '../../bootstrap/app.ts';

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(definition);
});
afterAll(() => app.close());

// The app shows what `marmeon check` asks of every app: the migrations of the packages it publishes from are in it.
it('has every migration of the packages it uses', async () => {
  const run = await app.command('publish', { options: { check: true } });
  expect(run.lines).toEqual(['✓ Every package you publish from has its migrations in your app']);
  expect(run.code).toBe(0);
});

// Each of the six packages that ship tables is found by its provider and has every migration in the app.
it.each(['@marmeon/auth', '@marmeon/cache', '@marmeon/notifications', '@marmeon/queue', '@marmeon/session', '@marmeon/storage'])('has every migration of %s', async (name) => {
  const run = await app.command('publish', { args: [name], options: { check: true } });
  expect(run.lines).toEqual([`✓ Every migration of ${name} is in your app`]);
  expect(run.code).toBe(0);
});

const MAKE_COMMANDS = [
  ['@marmeon/cache', 'cache', 'make:cache-table'],
  ['@marmeon/session', 'session', 'make:session-table'],
  ['@marmeon/queue', 'queue', 'make:queue-table'],
  ['@marmeon/notifications', 'notifications', 'make:notifications-table'],
  ['@marmeon/storage', 'storage', 'make:uploads-table'],
  ['@marmeon/auth', 'auth', 'make:sign-ins-table'],
] as const;

// A make:*-table command is publish for its own package: both write the same files, into the same module (only the packages of
// the workspace are all here, so the comparison of the six lives in this app).
it.each(MAKE_COMMANDS)('%s: its make command writes the same bytes as publish, to the same path', async (name, directory, command) => {
  const appRoot = (): string => {
    const root = tempDir('marmeon-make-or-publish-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [name]: 'workspace:*' } }));
    mkdirSync(join(root, 'node_modules/@marmeon'), { recursive: true });
    symlinkSync(fileURLToPath(new URL(`../../../../packages/${directory}`, import.meta.url)), join(root, 'node_modules', name));
    return root;
  };
  const published = appRoot();
  const made = appRoot();
  expect((await app.command('publish', { root: published, args: [name] })).code).toBe(0);
  expect((await app.command(command, { root: made })).code).toBe(0);
  const files = (root: string) => readdirSync(join(root, 'modules'), { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.ts')).sort();
  const stripped = (path: string) => path.replace(/\/\d{4}_\d{2}_\d{2}_\d{6}_/, '/');
  expect(files(made).map(stripped)).toEqual(files(published).map(stripped));
  expect(files(published).length).toBeGreaterThan(1);
  for (const [index, path] of files(published).entries()) {
    expect(readFileSync(join(made, 'modules', files(made)[index]!), 'utf8')).toBe(readFileSync(join(published, 'modules', path), 'utf8'));
  }
  // A second run writes nothing, and ends well.
  expect((await app.command(command, { root: made })).code).toBe(0);
  expect(files(made)).toHaveLength(files(published).length);
});

// In an app that has the tables it ends with 0 and writes nothing, though this app installs the packages by workspace:*.
it.each(MAKE_COMMANDS.map(([name, , command]) => [name, command] as const))('has nothing left for the make command of %s', async (name, command) => {
  const root = tempDir('marmeon-web-app-tables-');
  const source = fileURLToPath(new URL('../..', import.meta.url));
  cpSync(join(source, 'modules'), join(root, 'modules'), { recursive: true });
  cpSync(join(source, 'package.json'), join(root, 'package.json'));
  const run = await app.command(command, { root });
  expect(run.lines.filter((line) => !line.endsWith('is there — skipped'))).toEqual([`✓ Nothing to publish — every migration of ${name} is in your app`]);
  expect(run.code).toBe(0);
});

// The six packages declare their directory on their provider. The reader that assigns a declaration to a package is tested in the
// database package; this app shows what the framework's providers declare: always `stubs/migrations`, into `system`.
it('has every provider that declares migrations be one of the framework\'s, from stubs/migrations into system', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const declared = app.application.providers.flatMap((Provider) => (Provider.migrations !== undefined ? [{ provider: Provider.name, ...Provider.migrations }] : []));
  expect(declared.map((entry) => entry.provider).sort()).toEqual(
    ['AuthServiceProvider', 'CacheServiceProvider', 'NotificationServiceProvider', 'QueueServiceProvider', 'SessionServiceProvider', 'StorageServiceProvider'],
  );
  const claimed: string[] = [];
  for (const [name] of MAKE_COMMANDS) {
    const packageDirectory = realpathSync(join(root, 'node_modules', name));
    const entry = declared.find((candidate) => fileURLToPath(candidate.from).startsWith(`${packageDirectory}${sep}`));
    expect(entry, name).toBeDefined();
    claimed.push(entry!.provider);
    expect(entry!.module, name).toBe('system');
    expect(entry!.from.protocol).toBe('file:');
    expect(fileURLToPath(entry!.from), name).toBe(join(packageDirectory, 'stubs/migrations'));
    expect(readdirSync(entry!.from).filter((file) => file.endsWith('.ts')).length, name).toBeGreaterThan(0);
  }
  expect(claimed.sort()).toEqual(declared.map((entry) => entry.provider).sort());
});
