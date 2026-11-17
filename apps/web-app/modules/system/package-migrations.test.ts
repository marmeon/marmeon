import { createHash } from 'node:crypto';
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

// Each of the seven packages that ship tables is found by its provider and has every migration in the app.
it.each(['@marmeon/auth', '@marmeon/cache', '@marmeon/live', '@marmeon/notifications', '@marmeon/queue', '@marmeon/session', '@marmeon/storage'])('has every migration of %s', async (name) => {
  const run = await app.command('publish', { args: [name], options: { check: true } });
  expect(run.lines).toEqual([`✓ Every migration of ${name} is in your app`]);
  expect(run.code).toBe(0);
});

// `marmeon-stubs.json` is what `publish` records, and what a later release of a package is compared with: for each of the seven packages
// it holds every migration of the package that the app has, with the hash of the package's file now.
it.each(['auth', 'cache', 'live', 'notifications', 'queue', 'session', 'storage'])('records every migration of @marmeon/%s in marmeon-stubs.json', (directory) => {
  const appRoot = fileURLToPath(new URL('../..', import.meta.url));
  const manifest = JSON.parse(readFileSync(join(appRoot, 'marmeon-stubs.json'), 'utf8')) as { sets: Record<string, { files: Record<string, { stub: string; sha256: string }> }> };
  const stubs = fileURLToPath(new URL(`../../../../packages/${directory}/stubs/migrations/`, import.meta.url));
  const appFiles = readdirSync(join(appRoot, 'modules'), { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.ts'));
  const expected: Record<string, { stub: string; sha256: string }> = {};
  for (const file of readdirSync(stubs).filter((name) => name.endsWith('.ts'))) {
    const migration = file.replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, '');
    const own = appFiles.filter((path) => path.replace(/^.*\//, '').replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, '') === migration);
    expect(own, file).toHaveLength(1);
    expected[`modules/${own[0]}`] = { stub: `stubs/migrations/${file}`, sha256: `sha256:${createHash('sha256').update(readFileSync(join(stubs, file))).digest('hex')}` };
  }
  expect(manifest.sets[`@marmeon/${directory}:stubs/migrations`]?.files).toEqual(expected);
});

// The web app's copy of a package migration is the package's file, byte for byte. The exception is the sign-ins table of @marmeon/auth,
// its only migration: the web app ran an older form of it and upgraded it with a migration of its own, and a migration that ran is never
// rewritten. packages/auth/src/framework-tables.test.ts proves that upgraded table equals the package's, so auth is not listed here.
const UPGRADE_HISTORY = ['create_sign_ins_table.ts'];
it.each(['cache', 'live', 'notifications', 'queue', 'session', 'storage'])('has the migrations of @marmeon/%s as the package ships them', (directory) => {
  const appRoot = fileURLToPath(new URL('../..', import.meta.url));
  const stubs = fileURLToPath(new URL(`../../../../packages/${directory}/stubs/migrations/`, import.meta.url));
  const appFiles = readdirSync(join(appRoot, 'modules'), { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.ts'));
  const named = (path: string) => path.replace(/^.*\//, '').replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, '');
  const files = readdirSync(stubs).filter((name) => name.endsWith('.ts') && !UPGRADE_HISTORY.includes(named(name)));
  expect(files.length, `@marmeon/${directory} ships no migration to compare`).toBeGreaterThan(0);
  for (const file of files) {
    const own = appFiles.filter((path) => named(path) === named(file));
    expect(own, file).toHaveLength(1);
    expect(readFileSync(join(appRoot, 'modules', own[0]!), 'utf8'), file).toBe(readFileSync(join(stubs, file), 'utf8'));
  }
});

const MAKE_COMMANDS = [
  ['@marmeon/cache', 'cache', 'make:cache-table'],
  ['@marmeon/session', 'session', 'make:session-table'],
  ['@marmeon/queue', 'queue', 'make:queue-table'],
  ['@marmeon/notifications', 'notifications', 'make:notifications-table'],
  ['@marmeon/storage', 'storage', 'make:uploads-table'],
  ['@marmeon/auth', 'auth', 'make:sign-ins-table'],
  ['@marmeon/live', 'live', 'make:live-table'],
] as const;

// A make:*-table command is publish for its own package: both write the same files, into the same module (only the packages of
// the workspace are all here, so the comparison of the seven lives in this app).
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

// The seven packages declare their directory on their provider. The reader that assigns a declaration to a package is tested in the
// database package; this app shows what the framework's providers declare: always `stubs/migrations`, into `system`.
it('has every provider that declares migrations be one of the framework\'s, from stubs/migrations into system', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  // The back office package is a fixture the app publishes from into a module of its own (`back-office/back-office-package.test.ts`), not one of the framework's.
  const declared = app.application.providers.flatMap((Provider) => (Provider.migrations !== undefined && Provider.name !== 'BackOfficeServiceProvider' ? [{ provider: Provider.name, ...Provider.migrations }] : []));
  expect(declared.map((entry) => entry.provider).sort()).toEqual(
    ['AuthServiceProvider', 'CacheServiceProvider', 'LiveServiceProvider', 'NotificationServiceProvider', 'QueueServiceProvider', 'SessionServiceProvider', 'StorageServiceProvider'],
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
