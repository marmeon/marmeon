import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateKey } from '@marmeon/encryption';
import { describe, expect, it, onTestFinished } from 'vitest';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { bin, marmeon, repo } from './__fixtures__/cli.js';

const blank = join(repo, 'apps/blank-app');
const env = (root: string) => ({ DB_DATABASE: join(root, 'storage/app.sqlite'), NODE_ENV: 'development', APP_KEY: generateKey(), APP_NAME: 'Mark', APP_URL: 'https://example.test' });

/** A copy of the blank app (SQLite), with `files` written over it (relative to the app); `bare` drops the framework packages but the core and the CLI. */
function app(files: Record<string, string> = {}): string {
  const root = realpathSync(workspaceTempDir('marmeon-doctor-'));
  cpSync(blank, root, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
  symlinkSync(join(blank, 'node_modules'), join(root, 'node_modules'), 'dir');
  mkdirSync(join(root, 'storage'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

interface Bare {
  /** The body of the definition's options after `root`, e.g. `discover: false`. */
  options?: string;
  /** Code before the definition: what the app does when it loads. */
  before?: string;
  /** Packages of the blank app that are installed (in `node_modules`) but not listed in `package.json`. */
  installed?: string[];
  /** Packages of the blank app installed in a `node_modules` above the app, as a hoisted install lays them out. */
  hoisted?: string[];
  /** Installed packages that `package.json` lists as dependencies too. */
  listed?: string[];
}

/** An app that lists and installs the core and the CLI only: no `@marmeon/database` among its dependencies. */
function bare({ options = '', before = '', installed = [], hoisted = [], listed = [] }: Bare = {}): string {
  const top = realpathSync(workspaceTempDir('marmeon-doctor-bare-'));
  let root = top;
  if (hoisted.length > 0) {
    mkdirSync(join(top, 'node_modules/@marmeon'), { recursive: true });
    for (const name of hoisted) symlinkSync(realpathSync(join(blank, 'node_modules', name)), join(top, 'node_modules', name), 'dir');
    root = join(top, 'app');
    mkdirSync(root);
  }
  mkdirSync(join(root, 'node_modules/@marmeon'), { recursive: true });
  for (const name of ['marmeon', '@marmeon/core', ...installed, ...listed]) symlinkSync(realpathSync(join(blank, 'node_modules', name)), join(root, 'node_modules', name), 'dir');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bare', type: 'module', dependencies: { '@marmeon/core': 'workspace:*', marmeon: 'workspace:*', ...Object.fromEntries(listed.map((name) => [name, 'workspace:*'])) } }));
  mkdirSync(join(root, 'bootstrap'));
  writeFileSync(
    join(root, 'bootstrap/app.ts'),
    `import { join } from 'node:path';\nimport { defineApplication } from '@marmeon/core';\n${before}\nexport default defineApplication({ root: join(import.meta.dirname, '..')${options ? `, ${options}` : ''} });\n`,
  );
  return root;
}

const doctor = (root: string, args: string[] = [], extra: Record<string, string> = {}) => marmeon(root, ['doctor', ...args], { ...env(root), ...extra }, 90_000);
const migrated = (files: Record<string, string> = {}) => {
  const root = app(files);
  expect(marmeon(root, ['migrate'], env(root), 60_000).code).toBe(0);
  return root;
};
const reportOf = (stdout: string, name: string) => JSON.parse(stdout).checks.find((report: { name: string }) => report.name === name);
const names = (stdout: string) => (JSON.parse(stdout).checks as { name: string }[]).map((report) => report.name);

const DOCTOR_NAMES = 'node,packages,boot,route-types,package-migrations,db-types,migrations,readiness';
const KEYS = ['severity', 'message', 'file', 'line', 'column', 'code', 'rule', 'fix', 'docs'];
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/formats/cli-doctor/${name}`, import.meta.url), 'utf8'));
/** `bootstrap/app.ts` of the blank app with a provider of `probe.ts`. */
const withProvider = () =>
  readFileSync(join(blank, 'bootstrap/app.ts'), 'utf8')
    .replace("import { AppConfig }", "import { ProbeProvider } from '../probe.ts';\nimport { AppConfig }")
    .replace('modules: [system],', 'modules: [system],\n  providers: [ProbeProvider],');
describe('marmeon doctor', { timeout: 120_000 }, () => {
  it('passes every check of a valid app on SQLite, in doctor order, and exits 0', () => {
    const { code, stdout } = doctor(migrated(), ['--json']);
    expect(code).toBe(0);
    expect(names(stdout)).toEqual(['node', 'packages', 'boot', 'route-types', 'package-migrations', 'db-types', 'migrations', 'readiness']);
    for (const report of JSON.parse(stdout).checks) expect(report.status, report.name).toBe('passed');
  });

  it('prints the lines of check, and its last line, without --json', () => {
    const { code, stdout } = doctor(migrated(), ['--only=node,boot']);
    expect(code).toBe(0);
    expect(stdout.split('\n')).toEqual(expect.arrayContaining(['✓ node', '✓ boot', 'Passed (exit 0).']));
  });

  it('prints a failed boot with its fix, and the line of exit 1', () => {
    const { code, stdout, stderr } = doctor(app(), ['--only=boot'], { APP_KEY: '' });
    expect(code).toBe(1);
    expect(stderr).toContain('✗ boot — 1 error');
    expect(stdout).toContain('  $ marmeon key:generate');
    expect(stdout).toContain('Failed: a check found errors (exit 1).');
  });

  it('fails boot with the fix marmeon key:generate when APP_KEY is missing, skips what needs the booted app, and exits 1', () => {
    const { code, stdout } = doctor(app(), ['--json'], { APP_KEY: '' });
    expect(code).toBe(1);
    expect(reportOf(stdout, 'boot')).toMatchObject({ status: 'failed', problems: [{ severity: 'error', code: 'K6', fix: 'marmeon key:generate' }] });
    for (const name of ['db-types', 'readiness']) expect(reportOf(stdout, name)).toMatchObject({ status: 'skipped', reason: 'the app did not load' });
    const document = JSON.parse(stdout);
    expect({ ...document, checks: document.checks.filter((report: { name: string }) => report.name === 'boot') }).toMatchObject(fixture('v1-boot-failed.json'));
    for (const problem of reportOf(stdout, 'boot').problems) expect(Object.keys(problem)).toEqual(KEYS);
  });

  it('answers a name of check with exit 2, naming the checks of doctor', () => {
    const { code, stdout, stderr } = doctor(app(), ['--only=types']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('--only names no check: types');
    expect(stderr).toContain('The checks are: node, packages, boot, route-types, package-migrations, db-types, migrations, readiness.');
  });

  it('answers a wrong --skip, and options that leave no check, with exit 2', () => {
    const root = app();
    expect(doctor(root, ['--skip=bogus'])).toMatchObject({ code: 2, stdout: '' });
    expect(doctor(root, ['--only=node', '--skip=node']).code).toBe(2);
    expect(doctor(root, ['--only=']).code).toBe(2);
    expect(doctor(root, ['--skip=']).code).toBe(2);
    expect(doctor(root, [`--skip=${DOCTOR_NAMES}`]).code).toBe(2);
  });

  it('prints one document of the stored format (keys and types)', () => {
    const { code, stdout } = doctor(migrated(), ['--only=node,boot', '--json']);
    expect(code).toBe(0);
    expect(stdout.endsWith('\n')).toBe(true);
    const document = JSON.parse(stdout);
    expect(Object.keys(document)).toEqual(['format', 'ok', 'exitCode', 'checks', 'warnings']);
    expect(document).toMatchObject(fixture('v1.json'));
    for (const report of document.checks) {
      expect(report.ms).toEqual(expect.any(Number));
      expect(Object.keys(report)).toEqual(['name', 'status', 'ms', 'reason', 'problems', 'silenced']);
    }
  });

  it('shows a warning of the node check as a problem, in text and in the document', () => {
    const root = migrated({ '.nvmrc': '1\n' });
    const { code, stdout, stderr } = doctor(root, ['--only=node', '--json']);
    expect(code).toBe(0);
    const document = JSON.parse(stdout);
    expect(document).toMatchObject(fixture('v1-node-warning.json'));
    expect(document.checks[0].problems[0].message).toMatch(/^Node \d+\.\d+\.\d+.* runs this; \.nvmrc asks for 1$/);
    for (const problem of document.checks[0].problems) expect(Object.keys(problem)).toEqual(KEYS);
    const text = doctor(root, ['--only=node']);
    expect(text.code).toBe(0);
    expect(text.stderr).toContain('node — 1 warning');
    expect(text.stdout).toContain('asks for 1');
    expect(stderr).toBe('');
  });

  it('skips the checks of the database package, with the reason, in an app without it', () => {
    const { code, stdout } = doctor(bare(), ['--only=package-migrations,db-types', '--json']);
    expect(code).toBe(0);
    for (const name of ['package-migrations', 'db-types']) expect(reportOf(stdout, name)).toMatchObject({ status: 'skipped', reason: '@marmeon/database is not installed' });
  });

  it('is an error, not a skip, when @marmeon/database is installed and its provider is not registered', () => {
    const options = 'discover: false, providers: [CliServiceProvider]';
    const before = "import { CliServiceProvider } from 'marmeon';";
    const { code, stdout } = doctor(bare({ options, before, listed: ['@marmeon/database'] }), ['--only=package-migrations,db-types', '--json']);
    expect(code).toBe(3);
    for (const name of ['package-migrations', 'db-types']) {
      expect(reportOf(stdout, name)).toMatchObject({ status: 'error', reason: expect.stringContaining('DatabaseServiceProvider') });
    }
  });

  it('is an error for route-types when the provider of the CLI is not registered', () => {
    const { code, stdout } = doctor(bare({ options: 'discover: false' }), ['--only=route-types', '--json']);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'route-types')).toMatchObject({ status: 'error', reason: expect.stringContaining('CliServiceProvider') });
  });

  it('fails route-types for a stale bootstrap/routes.ts', () => {
    const root = migrated();
    writeFileSync(join(root, 'bootstrap/routes.ts'), `${readFileSync(join(root, 'bootstrap/routes.ts'), 'utf8')}\n// edited\n`);
    const { code, stdout } = doctor(root, ['--only=route-types', '--json']);
    expect(code).toBe(1);
    expect(reportOf(stdout, 'route-types')).toMatchObject({ status: 'failed', problems: [{ message: 'bootstrap/routes.ts is out of date', fix: 'marmeon route:types' }] });
  });

  it('fails readiness when a health check of the app fails, and exits 1', () => {
    const probe = `
export class DownCheck { static check = 'cache-down'; handle() { throw new Error('connect failed'); } }
export class ProbeProvider { static health = [DownCheck]; }
`;
    const { code, stdout } = doctor(migrated({ 'probe.ts': probe, 'bootstrap/app.ts': withProvider() }), ['--only=readiness', '--json']);
    expect(code).toBe(1);
    expect(reportOf(stdout, 'readiness')).toMatchObject({ status: 'failed', problems: [{ severity: 'error', rule: 'cache-down' }] });
  });

  it('does not run the checks that a package, a module or the app registers, and does not know their names', () => {
    const probe = `
export class Failing { static check = 'failing'; static phase = 'build' as const; handle() { return [{ severity: 'error' as const, message: 'always' }]; } }
export class ProbeProvider { static checks = [Failing]; }
`;
    const root = migrated({ 'probe.ts': probe, 'bootstrap/app.ts': withProvider() });
    // The same app fails `marmeon check`, so the probe is registered.
    expect(marmeon(root, ['check', '--only=failing'], env(root), 90_000).code).toBe(1);
    const { code, stdout } = doctor(root, ['--json']);
    expect(code).toBe(0);
    expect(names(stdout)).not.toContain('failing');
    expect(doctor(root, ['--only=failing'])).toMatchObject({ code: 2, stdout: '' });
  });

  it('ends after its report although the app leaves a timer running', () => {
    const { code, stdout } = doctor(bare({ before: 'setInterval(() => {}, 1000);' }), ['--only=boot', '--json']);
    // A launcher that waited for the timer would be killed by the spawn timeout: no code.
    expect(code).toBe(0);
    expect(reportOf(stdout, 'boot').status).toBe('passed');
  });

  it.each(['development', 'test'])('warns that marmeon start refuses when NODE_ENV=%s comes from .env alone', (name) => {
    const root = migrated({ '.env': `NODE_ENV=${name}\n` });
    const { code, stdout } = doctor(root, ['--only=node', '--json'], { NODE_ENV: '' });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).warnings).toEqual([`marmeon start refuses on this machine: NODE_ENV=${name} comes from .env alone, and doctor checked the ${name} configuration.`]);
    // Set in the environment, it is the machine's own choice.
    expect(JSON.parse(doctor(root, ['--only=node', '--json']).stdout).warnings).toEqual([]);
  });
  it('is an error for a database check when only the provider of the database is registered, and names the provider of the CLI', () => {
    const options = 'discover: false, providers: [DatabaseServiceProvider]';
    const before = "import { DatabaseServiceProvider } from '@marmeon/database';";
    const { code, stdout } = doctor(bare({ options, before, installed: ['@marmeon/database'] }), ['--only=db-types,package-migrations', '--json']);
    expect(code).toBe(3);
    for (const name of ['db-types', 'package-migrations']) {
      const { reason } = reportOf(stdout, name);
      expect(reason).toContain('CliServiceProvider');
      expect(reason).not.toContain('DatabaseServiceProvider');
    }
  });

  it.each([
    ['db-types', 'build'],
    ['db-types', 'run'],
    ['package-migrations', 'build'],
    ['package-migrations', 'run'],
  ])('does not call a check of the app named %s (phase %s) in place of the check of its package', (name, phase) => {
    // `Own` is the provider and the check it brings: it passes without looking at anything, and leaves a mark when it is called.
    const marker = join(realpathSync(tempDir('marmeon-doctor-marker-')), 'ran');
    const before = `import { writeFileSync } from 'node:fs';
import { CliServiceProvider } from 'marmeon';
class Own { static check = '${name}'; static phase = '${phase}' as const; static checks: unknown[] = []; handle() { writeFileSync(process.env.MARMEON_DOCTOR_MARKER!, 'ran'); return []; } }
Own.checks.push(Own);`;
    const options = 'discover: false, providers: [CliServiceProvider, Own]';
    const { code, stdout } = doctor(bare({ options, before, listed: ['@marmeon/database'] }), [`--only=${name}`, '--json'], { MARMEON_DOCTOR_MARKER: marker });
    expect(existsSync(marker)).toBe(false);
    expect(code).toBe(3);
    expect(reportOf(stdout, name)).toMatchObject({ status: 'error', reason: expect.stringContaining('DatabaseServiceProvider') });
  });

  it('does not call a route-types check of a registry the app binds itself, and names the provider of the CLI', () => {
    const marker = join(realpathSync(tempDir('marmeon-doctor-marker-')), 'ran');
    const registry = new URL('./check/registry.ts', import.meta.url).href;
    const before = `import { writeFileSync } from 'node:fs';
import { CheckRegistry } from '${registry}';
class Fake { static check = 'route-types'; static phase = 'build' as const; handle() { writeFileSync(process.env.MARMEON_DOCTOR_MARKER!, 'ran'); return []; } }
class Own { register(container: { instance(token: unknown, value: unknown): void }) { container.instance(CheckRegistry, new CheckRegistry().add([Fake])); } }`;
    const { code, stdout } = doctor(bare({ options: 'discover: false, providers: [Own]', before }), ['--only=route-types', '--json'], { MARMEON_DOCTOR_MARKER: marker });
    expect(existsSync(marker)).toBe(false);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'route-types')).toMatchObject({ status: 'error', reason: expect.stringContaining('CliServiceProvider') });
  });

  it('skips the database checks when @marmeon/database lies only in a node_modules above the app, which does not depend on it', () => {
    const { code, stdout } = doctor(bare({ hoisted: ['@marmeon/database'] }), ['--only=package-migrations,db-types', '--json']);
    expect(code).toBe(0);
    for (const name of ['package-migrations', 'db-types']) expect(reportOf(stdout, name)).toMatchObject({ status: 'skipped', reason: '@marmeon/database is not installed' });
  });

  it('loads the app only for the checks that need it', () => {
    const marker = join(realpathSync(tempDir('marmeon-doctor-marker-')), 'loaded');
    const before = "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.MARMEON_DOCTOR_MARKER!, 'loaded');";
    const root = bare({ before });
    const extra = { MARMEON_DOCTOR_MARKER: marker };
    expect(doctor(root, ['--only=node,packages', '--json'], extra).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    // The positive control: the same app, loaded by a check that needs it.
    expect(doctor(root, ['--only=boot', '--json'], extra).code).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it('fails migrations with one problem for each migration that has not run, with the fix, and passes after marmeon migrate', () => {
    const root = app();
    const before = doctor(root, ['--only=migrations', '--json']);
    expect(before.code).toBe(1);
    const report = reportOf(before.stdout, 'migrations');
    expect(report.status).toBe('failed');
    expect(report.problems.length).toBeGreaterThan(0);
    for (const problem of report.problems) {
      expect(problem).toMatchObject({ severity: 'error', message: expect.stringMatching(/^\S+ \(module \S+\) has not run$/), fix: 'marmeon migrate', docs: 'docs/migrations.md#running-migrations' });
    }
    expect(report.problems.map((problem: { message: string }) => problem.message)).toEqual(expect.arrayContaining([expect.stringMatching(/_create_notifications_table \(module system\) has not run$/)]));
    const text = doctor(root, ['--only=migrations']);
    expect(text.code).toBe(1);
    expect(text.stdout + text.stderr).toContain('has not run');
    expect(marmeon(root, ['migrate'], env(root), 60_000).code).toBe(0);
    const after = doctor(root, ['--only=migrations', '--json']);
    expect(after.code).toBe(0);
    expect(reportOf(after.stdout, 'migrations')).toMatchObject({ status: 'passed', problems: [] });
  });

  it('shows a migration that changed after it ran as a warning of migrations, and exits 0', () => {
    const root = migrated();
    const file = join(root, 'modules/system/migrations', readdirSync(join(root, 'modules/system/migrations')).find((name) => name.endsWith('_create_notifications_table.ts'))!);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n// edited after it ran\n`);
    const { code, stdout } = doctor(root, ['--only=migrations', '--json']);
    const report = reportOf(stdout, 'migrations');
    expect(code).toBe(0);
    expect(report).toMatchObject({ status: 'warning', problems: [{ severity: 'warning', message: expect.stringMatching(/changed since it ran in batch 1$/) }] });
  });

  it('skips migrations, with the reason, in an app without @marmeon/database', () => {
    const { code, stdout } = doctor(bare(), ['--only=migrations', '--json']);
    expect(code).toBe(0);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'skipped', reason: '@marmeon/database is not installed' });
  });

  it('skips migrations when @marmeon/database lies only in a node_modules above the app, which does not depend on it', () => {
    const { code, stdout } = doctor(bare({ hoisted: ['@marmeon/database'] }), ['--only=migrations', '--json']);
    expect(code).toBe(0);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'skipped', reason: '@marmeon/database is not installed' });
  });

  it('is an error for migrations, not a skip, when @marmeon/database is a dependency and its provider is not registered', () => {
    const options = 'discover: false, providers: [CliServiceProvider]';
    const before = "import { CliServiceProvider } from 'marmeon';";
    const { code, stdout } = doctor(bare({ options, before, listed: ['@marmeon/database'] }), ['--only=migrations', '--json']);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'error', reason: expect.stringContaining('DatabaseServiceProvider') });
  });

  it('is an error for migrations when the provider of the CLI is not registered, and names it', () => {
    const { code, stdout } = doctor(bare({ options: 'discover: false', listed: ['@marmeon/database'] }), ['--only=migrations', '--json']);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'error', reason: expect.stringContaining('CliServiceProvider') });
  });

  it('does not run a migrate:status of the app in place of the command of @marmeon/database', () => {
    const marker = join(realpathSync(tempDir('marmeon-doctor-marker-')), 'ran');
    const before = `import { writeFileSync } from 'node:fs';
import { CliServiceProvider } from 'marmeon';
class Own { static command = 'migrate:status'; static options = {}; handle() { writeFileSync(process.env.MARMEON_DOCTOR_MARKER!, 'ran'); return 0; } }
class OwnProvider { static commands = [Own]; }`;
    const options = 'discover: false, providers: [CliServiceProvider, OwnProvider]';
    const { code, stdout } = doctor(bare({ options, before, listed: ['@marmeon/database'] }), ['--only=migrations', '--json'], { MARMEON_DOCTOR_MARKER: marker });
    expect(existsSync(marker)).toBe(false);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'error', reason: expect.stringContaining('DatabaseServiceProvider') });
  });

  it('skips migrations, not an error of its own, when the app did not load and boot is selected', () => {
    const { code, stdout } = doctor(app(), ['--only=boot,migrations', '--json'], { APP_KEY: '' });
    expect(code).toBe(1);
    expect(reportOf(stdout, 'boot').status).toBe('failed');
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'skipped', reason: 'the app did not load' });
  });

  it('is an error, never failed, when the app does not load and boot is not selected', () => {
    const { code, stdout } = doctor(app({ 'bootstrap/app.ts': "throw new Error('the definition fails');" }), ['--only=migrations', '--json']);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'error', problems: [], reason: expect.stringMatching(/^the app did not load: .*the definition fails/s) });
  });

  it('is an error, never failed, with the reason of the app when it fails only when it runs', () => {
    const { code, stdout } = doctor(app(), ['--only=migrations', '--json'], { APP_KEY: '' });
    expect(code).toBe(3);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'error', problems: [], reason: expect.stringMatching(/^the app did not load: .*APP_KEY/s) });
  });

  it('is an error, exit 3, when the app cannot start on its database: a missing directory of the SQLite file', () => {
    const root = app();
    const { code, stdout } = doctor(root, ['--only=migrations', '--json'], { DB_DATABASE: join(root, 'missing-directory/app.sqlite') });
    expect(code).toBe(3);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'error', problems: [], reason: expect.stringMatching(/^the app did not load: .*does not exist/s) });
  });

  it('is an error, exit 3, for an unreachable host: the reason shows the URL with its password masked by the driver, and no output has the password', () => {
    const password = ['p4ss', 'w0rd', 'unlikely'].join('-');
    const extra = { DB_DRIVER: 'pgsql', DB_URL: `postgres://app:${password}@127.0.0.1:1/shop` };
    const root = app();
    const json = doctor(root, ['--only=migrations', '--json'], extra);
    expect(json.code).toBe(3);
    expect(reportOf(json.stdout, 'migrations')).toMatchObject({ status: 'error', problems: [], reason: expect.stringContaining('Could not connect') });
    expect(reportOf(json.stdout, 'migrations').reason).toContain('postgres://app:***@127.0.0.1:1/shop');
    const text = doctor(root, ['--only=migrations'], extra);
    expect(text.code).toBe(3);
    for (const output of [json.stdout, json.stderr, text.stdout, text.stderr]) expect(output).not.toContain(password);
  });

  it('loads the app once for migrations alone, and not at all without it', () => {
    const marker = join(realpathSync(tempDir('marmeon-doctor-marker-')), 'loaded');
    const before = "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.MARMEON_DOCTOR_MARKER!, 'x');";
    const root = bare({ before });
    const extra = { MARMEON_DOCTOR_MARKER: marker };
    expect(doctor(root, ['--only=node,packages', '--json'], extra).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(doctor(root, ['--only=migrations', '--json'], extra).code).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('x');
  });

  it('shows a gone migration file as a warning of migrations, and exits 0', () => {
    const root = migrated();
    const dir = join(root, 'modules/system/migrations');
    rmSync(join(dir, readdirSync(dir).find((name) => name.endsWith('_create_notifications_table.ts'))!));
    const { code, stdout } = doctor(root, ['--only=migrations', '--json']);
    expect(code).toBe(0);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'warning', problems: [{ severity: 'warning', message: expect.stringMatching(/ran in batch 1 but no module has its file$/) }] });
  });

  it('is failed, with both problems, for a pending migration and a warning together', () => {
    const root = migrated();
    const dir = join(root, 'modules/system/migrations');
    rmSync(join(dir, readdirSync(dir).find((name) => name.endsWith('_create_notifications_table.ts'))!));
    writeFileSync(join(dir, '2099_01_01_000000_create_notes_table.ts'), "export default { up(schema) { schema.create('notes', (t) => { t.id(); }); } };\n");
    const { code, stdout } = doctor(root, ['--only=migrations', '--json']);
    expect(code).toBe(1);
    const report = reportOf(stdout, 'migrations');
    expect(report.status).toBe('failed');
    expect(report.problems.map((problem: { severity: string }) => problem.severity).sort()).toEqual(['error', 'warning']);
  });

  it('runs migrations when only the database provider is registered and the package lies in a node_modules above the app', () => {
    const before = "import { CliServiceProvider } from 'marmeon';\nimport { DatabaseServiceProvider } from '@marmeon/database';\nimport notes from '../notes/index.ts';";
    const root = bare({ options: 'discover: false, modules: [notes], providers: [CliServiceProvider, DatabaseServiceProvider]', before, hoisted: ['@marmeon/database'] });
    mkdirSync(join(root, 'storage'));
    mkdirSync(join(root, 'notes/migrations'), { recursive: true });
    writeFileSync(join(root, 'notes/index.ts'), "import { defineModule } from '@marmeon/core';\nexport default defineModule({ name: 'notes', migrations: new URL('./migrations/', import.meta.url) });\n");
    writeFileSync(join(root, 'notes/migrations/2099_01_01_000000_create_notes_table.ts'), "export default { up(schema) { schema.create('notes', (t) => { t.id(); }); } };\n");
    const { code, stdout } = doctor(root, ['--only=migrations', '--json']);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'failed', problems: [{ message: '2099_01_01_000000_create_notes_table (module notes) has not run' }] });
    expect(code).toBe(1);
  });

  it('is an error, not a skip, when the packages of the app cannot be discovered', () => {
    const options = 'discover: false, providers: [CliServiceProvider]';
    const before = "import { CliServiceProvider } from 'marmeon';";
    const root = bare({ options, before, listed: ['@marmeon/database'] });
    // A generated directory that is a link out of the project: discovery refuses it.
    symlinkSync(realpathSync(tempDir('marmeon-doctor-outside-')), join(root, '.marmeon'), 'dir');
    const { code, stdout } = doctor(root, ['--only=migrations,db-types', '--json']);
    expect(code).toBe(3);
    for (const name of ['migrations', 'db-types']) expect(reportOf(stdout, name)).toMatchObject({ status: 'error', reason: expect.stringContaining('could not be discovered') });
  });

  /** An app whose definition runs `code` on its first load (doctor's) and `onChild` on the later ones (the child of `migrations`); `STATE` is a directory of the test. */
  function twoLoads(onFirst: string, onChild: string): string {
    const state = "const state = process.env.MARMEON_DOCTOR_STATE!;\nconst first = !existsSync(`${state}/loaded`);\nif (first) writeFileSync(`${state}/loaded`, '1');\n";
    const source = readFileSync(join(blank, 'bootstrap/app.ts'), 'utf8');
    const code = `import { existsSync, writeFileSync } from 'node:fs';\n${state}if (first) {\n${onFirst}\n} else {\n${onChild}\n}\n`;
    return code + source;
  }

  it('keeps a failure that app code leaves behind while the child runs, masked with the patterns of the app, and exits 3', () => {
    const stray = ['st', 'ray', 'q8fz0kzb3t'].join('_');
    const state = realpathSync(tempDir('marmeon-doctor-state-'));
    const first = `setTimeout(() => void Promise.reject(new Error('left behind ${stray}')), 300);`;
    const source = twoLoads(first, '');
    // Migrated first: a clean run is exit 0, which a failure outside every check turns into 3.
    const root = migrated();
    writeFileSync(join(root, 'bootstrap/app.ts'), source.replace('defineApplication({', 'defineApplication({ redact: { patterns: [/\\bst_ray_[a-z0-9]{10}\\b/] },'));
    const { code, stdout, stderr } = doctor(root, ['--only=migrations', '--json'], { MARMEON_DOCTOR_STATE: state });
    expect(code).toBe(3);
    const document = JSON.parse(stdout);
    expect(document.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Unhandled failure that belongs to no check: .*left behind \[redacted\]/)]));
    expect(stdout + stderr).not.toContain(stray);
  });

  it('stops the child of migrations when doctor is interrupted, and reports the check as an error', async () => {
    const state = realpathSync(tempDir('marmeon-doctor-state-'));
    // The child leaves its pid and hangs; it ends by itself after a while, so a failing test leaves nothing behind.
    const hang = `process.on('SIGTERM', () => {});\nwriteFileSync(\`${'${state}'}/pid\`, String(process.pid));\nsetTimeout(() => process.exit(0), 45_000);\nawait new Promise(() => {});`;
    const root = app({ 'bootstrap/app.ts': twoLoads('', hang) });
    const { MARMEON_CHILD: _child, DB_DRIVER: _driver, DB_URL: _url, ...parent } = process.env;
    const child = spawn(process.execPath, [bin, 'doctor', '--only=migrations', '--json'], { cwd: root, env: { ...parent, NO_COLOR: '1', ...env(root), MARMEON_DOCTOR_STATE: state }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    const closed = new Promise<number | null>((resolveClose) => child.once('close', resolveClose));
    let pid = 0;
    onTestFinished(() => {
      child.kill('SIGKILL');
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone already, as it should be.
        }
      }
    });
    for (let waited = 0; !existsSync(join(state, 'pid')); waited += 100) {
      if (waited > 60_000) throw new Error('the child of migrations never started');
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    pid = Number(readFileSync(join(state, 'pid'), 'utf8'));
    // One Ctrl-C can deliver two signals; the second must not end doctor by default while the child that ignores SIGTERM is being stopped.
    child.kill('SIGINT');
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    child.kill('SIGINT');
    expect(await closed).toBe(3);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'error', reason: expect.stringContaining('cancelled') });
    // The group was sent SIGTERM at once; allow the grace the runner gives before it kills.
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let waited = 0; alive() && waited < 10_000; waited += 100) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(alive()).toBe(false);
  });

  it('does not run a migrate:status that a provider binds in boot(), and writes no mark', () => {
    const marker = join(realpathSync(tempDir('marmeon-doctor-marker-')), 'ran');
    const registry = new URL('./command.ts', import.meta.url).href;
    const root = app({ 'probe.ts': `import { writeFileSync } from 'node:fs';
import { CommandRegistry } from '${registry}';
class Own { static command = 'migrate:status'; static options = {}; handle() { writeFileSync(process.env.MARMEON_DOCTOR_MARKER!, 'ran'); return 0; } }
export class ProbeProvider { boot(app: { container: { instance(token: unknown, value: unknown): void } }) { app.container.instance(CommandRegistry, new CommandRegistry().add([Own])); } }
`, 'bootstrap/app.ts': withProvider() });
    const { code, stdout } = doctor(root, ['--only=migrations', '--json'], { MARMEON_DOCTOR_MARKER: marker });
    expect(existsSync(marker)).toBe(false);
    expect(code).toBe(3);
    expect(reportOf(stdout, 'migrations')).toMatchObject({ status: 'error', reason: expect.stringContaining('DatabaseServiceProvider') });
  });

  it('masks a pending migration with the patterns of the app', () => {
    const root = app({ 'modules/system/migrations/2099_01_01_000000_create_customer_acme_table.ts': "export default { up(schema) { schema.create('notes', (t) => { t.id(); }); } };\n" });
    writeFileSync(join(root, 'bootstrap/app.ts'), readFileSync(join(root, 'bootstrap/app.ts'), 'utf8').replace('defineApplication({', 'defineApplication({ redact: { patterns: [/customer_acme/] },'));
    const { code, stdout } = doctor(root, ['--only=migrations', '--json']);
    expect(code).toBe(1);
    const messages = reportOf(stdout, 'migrations').problems.map((problem: { message: string }) => problem.message);
    expect(messages).toContain('2099_01_01_000000_create_[redacted]_table (module system) has not run');
    expect(stdout).not.toContain('customer_acme');
  });
});
