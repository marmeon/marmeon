import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Application, ServiceProviderClass } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { AuthServiceProvider, NameGrabbingProvider, PermissionsProvider, QueueServiceProvider, SetGrabbingProvider } from '../__fixtures__/publish-providers.ts';
import { PublishCommand } from './publish.ts';

const STUB = (set: string) => `// @marmeon-stub ${set} 1\nexport default {};\n`;
const FIXTURE_PROVIDERS = pathToFileURL(join(import.meta.dirname, '..', '__fixtures__', 'publish-providers.ts')).href;
const PERM_FILES = { 'stubs/migrations/create_permissions_table.ts': STUB('permissions'), 'stubs/migrations/create_roles_table.ts': STUB('permissions') };

/** Writes a package into `<root>/node_modules`; `entry` is the source of its `index.js`, `providers` the names `marmeon.providers` lists. */
function install(root: string, name: string, files: Record<string, string>, extra: { module?: string; providers?: string[]; entry?: string; dependency?: boolean } = {}): void {
  const pkg = join(root, 'node_modules', name);
  mkdirSync(pkg, { recursive: true });
  const marmeon = { migrations: { format: 1, module: extra.module ?? 'permissions', files: Object.keys(files) }, ...(extra.providers ? { providers: extra.providers } : {}) };
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', exports: './index.js', marmeon }));
  writeFileSync(join(pkg, 'index.js'), extra.entry ?? '');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(pkg, path)), { recursive: true });
    writeFileSync(join(pkg, path), contents);
  }
  if (extra.dependency !== false) {
    const file = join(root, 'package.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    json.dependencies[name] = '1.0.0';
    writeFileSync(file, JSON.stringify(json));
  }
}

interface Setup {
  files?: Record<string, string>;
  /** Whether the app lists the package in its package.json. */
  dependency?: boolean;
  module?: string;
  providers?: string[];
  entry?: string;
}

/** An app with `@acme/perm` in node_modules (and, by default, in its dependencies). */
function makeApp(setup: Setup = {}): string {
  const root = tempDir('marmeon-publish-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
  install(root, '@acme/perm', setup.files ?? PERM_FILES, { module: setup.module, providers: setup.providers, entry: setup.entry, dependency: setup.dependency });
  mkdirSync(join(root, 'bootstrap'));
  writeFileSync(join(root, 'bootstrap/app.ts'), "import { defineApplication } from '@marmeon/core';\n\nexport default defineApplication({ root: '', modules: [] });\n");
  return root;
}

async function publish(root: string, args: string[] = ['@acme/perm'], options: Record<string, unknown> = {}, providers: readonly unknown[] = [], packages: string[] = []) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const app = { providers: providers as readonly ServiceProviderClass[], packages } as unknown as Application;
  const code = await new PublishCommand(app).handle({ root, args, options, output } as unknown as CommandInput);
  return { code, lines };
}

function written(root: string): string[] {
  const modules = join(root, 'modules');
  if (!existsSync(modules)) return [];
  return readdirSync(modules, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.ts')).sort();
}

describe('marmeon publish', () => {
  it('writes the migrations into the module the package proposes, which it creates and registers', async () => {
    const root = makeApp();
    const { code, lines } = await publish(root);
    expect(code).toBe(0);
    const migrations = readdirSync(join(root, 'modules/permissions/migrations'));
    expect(migrations).toHaveLength(2);
    expect(migrations[0]).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_permissions_table\.ts$/);
    expect(migrations[1]).toMatch(/_create_roles_table\.ts$/);
    expect(migrations[0]!.slice(0, 17) < migrations[1]!.slice(0, 17)).toBe(true);
    expect(readFileSync(join(root, 'modules/permissions/migrations', migrations[0]!), 'utf8')).toBe(STUB('permissions'));
    const index = readFileSync(join(root, 'modules/permissions/index.ts'), 'utf8');
    expect(index).toContain('The tables of @acme/perm: `marmeon publish @acme/perm` writes their migrations here.');
    expect(index).toContain("migrations: new URL('./migrations/', import.meta.url)");
    expect(readFileSync(join(root, 'bootstrap/app.ts'), 'utf8')).toContain('modules: [permissions]');
    expect(lines.filter((line) => line.startsWith('Then:'))).toEqual(['Then: marmeon migrate']);
  });

  it('writes nothing the second time and says so', async () => {
    const root = makeApp();
    await publish(root);
    const before = written(root);
    const again = await publish(root);
    expect(again.code).toBe(0);
    expect(again.lines.at(-1)).toBe('✓ Nothing to publish — every migration of @acme/perm is in your app');
    expect(written(root)).toEqual(before);
  });

  it('skips a migration the app has already, such as one make:auth wrote, and writes the rest next to it', async () => {
    const root = makeApp();
    mkdirSync(join(root, 'modules/auth/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/auth/index.ts'), "import { defineModule } from '@marmeon/core';\n\nexport default defineModule({ name: 'auth', migrations: new URL('./migrations/', import.meta.url) });\n");
    writeFileSync(join(root, 'modules/auth/migrations/2026_01_01_000000_create_roles_table.ts'), STUB('permissions'));
    const { code, lines } = await publish(root);
    expect(code).toBe(0);
    expect(lines).toContain('modules/auth/migrations/2026_01_01_000000_create_roles_table.ts is there — skipped');
    expect(readdirSync(join(root, 'modules/auth/migrations'))).toHaveLength(2);
    expect(existsSync(join(root, 'modules/permissions'))).toBe(false);
  });

  it('takes the module from --module over the one of the package', async () => {
    const root = makeApp();
    expect((await publish(root, ['@acme/perm'], { module: 'billing' })).code).toBe(0);
    expect(readdirSync(join(root, 'modules'))).toEqual(['billing']);
  });

  it('puts a file that appears later into the module that holds the others, not the proposed one', async () => {
    const root = makeApp();
    expect((await publish(root, ['@acme/perm'], { module: 'billing' })).code).toBe(0);
    install(root, '@acme/perm', { ...PERM_FILES, 'stubs/migrations/create_grants_table.ts': STUB('permissions') });
    expect((await publish(root)).code).toBe(0);
    expect(readdirSync(join(root, 'modules/billing/migrations'))).toHaveLength(3);
    expect(readdirSync(join(root, 'modules'))).toEqual(['billing']);
  });

  it('uses an existing system module, whose comment does not name the package', async () => {
    const root = makeApp({ module: 'system', files: { 'stubs/migrations/create_permissions_table.ts': STUB('permissions') } });
    expect((await publish(root)).code).toBe(0);
    expect(readdirSync(join(root, 'modules/system/migrations'))).toHaveLength(1);
    expect(readFileSync(join(root, 'modules/system/index.ts'), 'utf8')).toContain("The tables of the framework's drivers");
  });

  it('says to run make:upgrade-migrations when the sets of the package have upgrades missing', async () => {
    const root = makeApp({ providers: ['PermissionsProvider'], entry: `export { PermissionsProvider } from '${FIXTURE_PROVIDERS}';\n` });
    const { code, lines } = await publish(root, ['@acme/perm'], {}, [PermissionsProvider]);
    expect(code).toBe(0);
    expect(lines.filter((line) => line.startsWith('Then:'))).toEqual(['Then: marmeon make:upgrade-migrations', 'Then: marmeon migrate']);
  });

  it('finds a package in the node_modules of a workspace root with a lockfile, and no further up', async () => {
    const workspace = makeApp();
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), '');
    const app = join(workspace, 'apps/web');
    mkdirSync(join(app, 'bootstrap'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { '@acme/perm': '1.0.0' } }));
    writeFileSync(join(app, 'bootstrap/app.ts'), "import { defineApplication } from '@marmeon/core';\n\nexport default defineApplication({ root: '', modules: [] });\n");
    expect((await publish(app)).code).toBe(0);
    expect(readdirSync(join(app, 'modules/permissions/migrations'))).toHaveLength(2);

    // the lockfile sits below the node_modules: that one is not the app's
    const outer = makeApp();
    const inner = join(outer, 'apps/web');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'package.json'), JSON.stringify({ dependencies: { '@acme/perm': '1.0.0' } }));
    writeFileSync(join(inner, 'yarn.lock'), '');
    const refused = await publish(inner);
    expect(refused.code).toBe(1);
    expect(refused.lines[0]).toBe('✗ @acme/perm is not installed in your app — install your dependencies first.');
    expect(written(inner)).toEqual([]);
  });

  describe('refuses', () => {
    it('a package that is installed but not a dependency of the app', async () => {
      const root = makeApp({ dependency: false });
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines).toEqual(['✗ @acme/perm is not a dependency of your app — add it first.']);
      expect(written(root)).toEqual([]);
    });

    it('a package found only above the app, with no lockfile between', async () => {
      const parent = makeApp();
      const root = join(parent, 'apps/web');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@acme/perm': '1.0.0' } }));
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines[0]).toBe('✗ @acme/perm is not installed in your app — install your dependencies first.');
      expect(written(root)).toEqual([]);
    });

    it('a package without migrations', async () => {
      const root = makeApp();
      writeFileSync(join(root, 'node_modules/@acme/perm/package.json'), JSON.stringify({ name: '@acme/perm', marmeon: { providers: ['X'] } }));
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines).toEqual(['✗ @acme/perm ships no migrations.']);
    });

    it('a declaration that is wrong, writing nothing', async () => {
      const root = makeApp();
      const file = join(root, 'node_modules/@acme/perm/package.json');
      writeFileSync(file, JSON.stringify({ name: '@acme/perm', marmeon: { migrations: { format: 1, module: 'permissions', files: ['stubs/migrations/missing.ts'] } } }));
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines[0]).toContain('[marmeon:D21]');
      expect(written(root)).toEqual([]);
    });

    it('a --module that is no kebab-case name, writing nothing outside modules/', async () => {
      const root = makeApp();
      for (const module of ['../x', '..', 'a/b', 'Billing', '']) {
        const { code, lines } = await publish(root, ['@acme/perm'], { module });
        expect(code, module).toBe(1);
        expect(lines, module).toEqual(['✗ Pass the module as a kebab-case name: --module=<name>.']);
      }
      expect(written(root)).toEqual([]);
      expect(existsSync(join(root, 'x'))).toBe(false);
    });

    it('a module of the app that holds no migration of the package, unless --module names it', async () => {
      const root = makeApp();
      mkdirSync(join(root, 'modules/permissions/migrations'), { recursive: true });
      writeFileSync(join(root, 'modules/permissions/migrations/2026_01_01_000000_create_users_table.ts'), 'export default {};\n');
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines).toEqual(["✗ modules/permissions is your app's — pass --module=<name> to put the tables of @acme/perm there, or another name."]);
      expect(readdirSync(join(root, 'modules/permissions/migrations'))).toHaveLength(1);
      expect((await publish(root, ['@acme/perm'], { module: 'permissions' })).code).toBe(0);
    });

    it('a module of the app that holds a set of the package in a file the package does not list', async () => {
      const root = makeApp({ module: 'jobs', files: { 'stubs/migrations/create_tasks_table.ts': STUB('queue') } });
      mkdirSync(join(root, 'modules/jobs/migrations'), { recursive: true });
      writeFileSync(join(root, 'modules/jobs/migrations/2026_01_01_000000_create_jobs_table.ts'), STUB('queue'));
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines[0]).toContain('a migration of the "queue" tables that @acme/perm does not list');
      expect(readdirSync(join(root, 'modules/jobs/migrations'))).toHaveLength(1);
    });

    it('a set that another package upgrades, so that it cannot hide the upgrades of that set', async () => {
      const root = makeApp({ files: { 'stubs/migrations/create_permissions_table.ts': STUB('queue') } });
      const { code, lines } = await publish(root, ['@acme/perm'], {}, [QueueServiceProvider]);
      expect(code).toBe(1);
      expect(lines[0]).toContain('"queue" tables, which another package upgrades');
      expect(written(root)).toEqual([]);
    });

    it('a package with a provider class of its own under the name of the framework\'s', async () => {
      const root = makeApp({
        files: { 'stubs/migrations/create_permissions_table.ts': STUB('auth') },
        providers: ['AuthServiceProvider'],
        entry: 'export class AuthServiceProvider {}\n',
      });
      const { code, lines } = await publish(root, ['@acme/perm'], {}, [AuthServiceProvider]);
      expect(code).toBe(1);
      expect(lines[0]).toContain('"auth" tables, which another package upgrades');
      expect(written(root)).toEqual([]);
    });

    it('a package that re-exports the provider of another discovered package', async () => {
      const root = makeApp({
        files: { 'stubs/migrations/create_permissions_table.ts': STUB('queue') },
        providers: ['QueueServiceProvider'],
        entry: `export { QueueServiceProvider } from '${FIXTURE_PROVIDERS}';\n`,
      });
      install(root, '@acme/queue', { 'stubs/migrations/create_queue_tables.ts': STUB('other') }, { module: 'system', providers: ['QueueServiceProvider'], dependency: false });
      const { code, lines } = await publish(root, ['@acme/perm'], {}, [QueueServiceProvider], ['@acme/queue']);
      expect(code).toBe(1);
      expect(lines[0]).toContain('"queue" tables');
      expect(written(root)).toEqual([]);
      // without the other package the class is this package's own, and the set is its to publish
      expect((await publish(root, ['@acme/perm'], {}, [QueueServiceProvider], [])).code).toBe(0);
    });

    it('a set that the package takes over through an upgrade of its own provider', async () => {
      const root = makeApp({
        files: { 'stubs/migrations/create_permissions_table.ts': STUB('auth') },
        providers: ['SetGrabbingProvider'],
        entry: `export { SetGrabbingProvider } from '${FIXTURE_PROVIDERS}';\n`,
      });
      const { code, lines } = await publish(root, ['@acme/perm'], {}, [AuthServiceProvider, SetGrabbingProvider]);
      expect(code).toBe(1);
      expect(lines[0]).toContain('"auth" tables');
      expect(written(root)).toEqual([]);
    });

    it('a file name that the package takes over through an upgrade of its own provider', async () => {
      const root = makeApp({
        files: { 'stubs/migrations/create_jobs_table.ts': STUB('permissions') },
        providers: ['NameGrabbingProvider'],
        entry: `export { NameGrabbingProvider } from '${FIXTURE_PROVIDERS}';\n`,
      });
      install(root, '@marmeon/queue', { 'stubs/migrations/create_jobs_table.ts': STUB('queue') }, { module: 'system' });
      const { code, lines } = await publish(root, ['@acme/perm'], {}, [NameGrabbingProvider]);
      expect(code).toBe(1);
      expect(lines[0]).toContain('create_jobs_table, the name of a migration another package');
      expect(written(root)).toEqual([]);
    });

    it('a migration of the app without a stub mark that has the name of a listed file, and does not take its module', async () => {
      const root = makeApp({ files: { 'stubs/migrations/create_invoices_table.ts': STUB('permissions'), 'stubs/migrations/create_spy_table.ts': STUB('permissions') }, module: 'spy' });
      mkdirSync(join(root, 'modules/billing/migrations'), { recursive: true });
      writeFileSync(join(root, 'modules/billing/migrations/2026_01_01_000000_create_invoices_table.ts'), 'export default {};\n');
      mkdirSync(join(root, 'modules/spy'));
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines[0]).toContain("modules/spy is your app's");
      expect(readdirSync(join(root, 'modules/billing/migrations'))).toHaveLength(1);
    });

    it('a file name that another package creates or upgrades', async () => {
      const root = makeApp({ files: { 'stubs/migrations/rename_queue_tables.ts': STUB('permissions') } });
      const { code, lines } = await publish(root, ['@acme/perm'], {}, [QueueServiceProvider]);
      expect(code).toBe(1);
      expect(lines[0]).toContain('rename_queue_tables, the name of a migration another package');
      expect(written(root)).toEqual([]);
    });

    it('the stub of another dependency of the app, installed or not as a provider', async () => {
      const root = makeApp({ files: { 'stubs/migrations/create_sessions_table.ts': STUB('permissions') } });
      install(root, '@marmeon/session', { 'stubs/migrations/create_sessions_table.ts': STUB('sessions') }, { module: 'system' });
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines[0]).toContain('create_sessions_table, the name of a migration another package');
      expect(written(root)).toEqual([]);
    });

    it('a set that another dependency of the app brings', async () => {
      const root = makeApp({ files: { 'stubs/migrations/create_other_table.ts': STUB('sessions') } });
      install(root, '@marmeon/session', { 'stubs/migrations/create_sessions_table.ts': STUB('sessions') }, { module: 'system' });
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines[0]).toContain('"sessions" tables');
    });

    it('a name such as __proto__ or constructor as the package', async () => {
      const root = makeApp();
      expect((await publish(root, ['__proto__'])).code).toBe(1);
      expect((await publish(root, ['constructor'])).code).toBe(1);
      expect(written(root)).toEqual([]);
    });

    it('a symlink as a listed file', async () => {
      const root = makeApp();
      const target = join(tempDir('marmeon-publish-outside-'), 'secret.ts');
      writeFileSync(target, STUB('permissions'));
      const link = join(root, 'node_modules/@acme/perm/stubs/migrations/create_roles_table.ts');
      rmSync(link);
      symlinkSync(target, link);
      const { code } = await publish(root);
      expect(code).toBe(1);
      expect(written(root)).toEqual([]);
    });
  });
});
