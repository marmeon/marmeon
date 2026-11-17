import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Application, ServiceProviderClass } from '@marmeon/core';
import { readStubManifest, recordStubSet, STUB_MANIFEST, stubHash } from '@marmeon/core/internal';
import type { CheckProblem, CommandInput } from 'marmeon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { PackageMigrationsCheck } from '../checks.ts';
import { PublishCommand, publishOwnMigrations } from './publish.ts';

const STUB = (set: string) => `export default {}; // ${set}\n`;
const ELSEWHERE = (file: string, pkg: string, where: string) =>
  `✗ Your app already has a migration named ${file} in modules/${where}, and ${pkg} ships one by that name. If publish should put the files of ${pkg} there, pass --module=${where}; otherwise ${pkg} ships a name your app uses for something else.`;
const PERM_FILES = { 'stubs/migrations/create_permissions_table.ts': STUB('permissions'), 'stubs/migrations/create_roles_table.ts': STUB('permissions') };

const shipped = (index: number) => `2026_01_01_${String(index).padStart(6, '0')}`;

/** The service provider each installed test package declares its migrations on, by the package's directory. */
const providerClasses = new Map<string, ServiceProviderClass>();
const registry = ((globalThis as { __providersOfTest?: Map<string, unknown> }).__providersOfTest ??= new Map<string, unknown>());

/** A service provider class that declares `migrations` as its static. */
function providerClass(name: string, migrations: unknown): ServiceProviderClass {
  const Provider = class {
    static migrations = migrations;
  };
  Object.defineProperty(Provider, 'name', { value: name });
  return Provider as unknown as ServiceProviderClass;
}

/** The providers the app boots: those of the packages installed in `root`, plus `more`. */
function providersOf(root: string, more: readonly ServiceProviderClass[] = []): ServiceProviderClass[] {
  // The packages of the app's own node_modules, and of the one of a workspace above it.
  const installed = ([dir]: [string, unknown]) => dir.startsWith(`${root}/`) || root.startsWith(`${dir.slice(0, dir.indexOf('/node_modules/'))}/`);
  return [...[...providerClasses].filter(installed).map(([, Provider]) => Provider), ...more];
}

const commandOf = (root: string, more: readonly ServiceProviderClass[] = []) => new PublishCommand({ root, providers: providersOf(root, more) } as unknown as Application);

/**
 * Writes a package into `<root>/node_modules`; `entry` is the source added to its `index.js`, `providers` the names `marmeon.providers`
 * lists. The entry exports a service provider that declares `stubs/migrations` (`from` names another directory) and `module`,
 * unless `declare` is false.
 */
function install(
  root: string,
  name: string,
  files: Record<string, string>,
  extra: { module?: string; providers?: string[]; entry?: string; dependency?: boolean; spec?: string; from?: string; declare?: boolean; version?: string } = {},
): void {
  const pkg = join(root, 'node_modules', name);
  mkdirSync(pkg, { recursive: true });
  const marmeon = extra.providers ? { providers: extra.providers } : undefined;
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: extra.version ?? '1.0.0', exports: './index.js', ...(marmeon ? { marmeon } : {}) }));
  if (extra.declare === false) {
    providerClasses.delete(pkg);
    writeFileSync(join(pkg, 'index.js'), extra.entry ?? '');
  } else {
    // A package that is installed again keeps its class: the entry is imported once and hands out the class it first found.
    // The real path, as `import.meta.url` is: a directory that does not exist is placed by where the URL says it lies.
    const migrations = { from: pathToFileURL(join(realpathSync(pkg), extra.from ?? 'stubs/migrations')), module: extra.module ?? 'permissions' };
    const Provider = providerClasses.get(pkg) ?? providerClass(`${name.replace(/\W+/g, '_')}ServiceProvider`, migrations);
    (Provider as unknown as { migrations: unknown }).migrations = migrations;
    providerClasses.set(pkg, Provider);
    registry.set(pkg, Provider);
    writeFileSync(join(pkg, 'index.js'), `export const provider = globalThis.__providersOfTest.get(${JSON.stringify(pkg)});\n${extra.entry ?? ''}`);
  }
  // The files are given by their name; the package ships them in the order given, each with its own timestamp.
  for (const [index, [path, contents]] of Object.entries(files).entries()) {
    const file = path.replace(/([^/]+)$/, `${shipped(index)}_$1`);
    mkdirSync(dirname(join(pkg, file)), { recursive: true });
    writeFileSync(join(pkg, file), contents);
  }
  if (extra.dependency !== false) {
    const file = join(root, 'package.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    json.dependencies[name] = extra.spec ?? '1.0.0';
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
  /** What the app's package.json says for the package. */
  spec?: string;
  /** The package name; `@acme/perm` by default. */
  name?: string;
  /** The directory the provider declares, in the package. */
  from?: string;
  /** Whether the package declares its migrations at all; true by default. */
  declare?: boolean;
}

/** An app with `@acme/perm` in node_modules (and, by default, in its dependencies). */
function makeApp(setup: Setup = {}): string {
  const root = tempDir('marmeon-publish-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
  install(root, setup.name ?? '@acme/perm', setup.files ?? PERM_FILES, { module: setup.module, providers: setup.providers, entry: setup.entry, dependency: setup.dependency, spec: setup.spec, from: setup.from, declare: setup.declare });
  mkdirSync(join(root, 'bootstrap'));
  writeFileSync(join(root, 'bootstrap/app.ts'), "import { defineApplication } from '@marmeon/core';\n\nexport default defineApplication({ root: '', modules: [] });\n");
  return root;
}

/** A prompt that answers with the indexes `pick` returns for the choices it is shown; a prompt that is not `interactive` throws like the real one. */
function fakePrompt(interactive: boolean, pick: (choices: readonly string[]) => number[] = () => []) {
  const asked: { question: string; choices: readonly string[] }[] = [];
  return {
    asked,
    interactive,
    async choose(question: string, choices: readonly string[]) {
      if (!interactive) throw new Error('Cannot ask a question');
      asked.push({ question, choices });
      return pick(choices);
    },
  };
}

async function publish(
  root: string,
  args: string[] = ['@acme/perm'],
  options: Record<string, unknown> = {},
  prompt: ReturnType<typeof fakePrompt> = fakePrompt(false),
  more: readonly ServiceProviderClass[] = [],
) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const code = await commandOf(root, more).handle({ root, args, options, output, prompt } as unknown as CommandInput);
  return { code, lines };
}

function written(root: string): string[] {
  const modules = join(root, 'modules');
  if (!existsSync(modules)) return [];
  return readdirSync(modules, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.ts')).sort();
}

// `publish` names its files after the wall clock; a test that publishes twice and compares names must not straddle a second.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-05-06T07:08:09.000Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

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

  it('skips a migration the app has already, such as one make:auth wrote, and writes the rest where --module says', async () => {
    const root = makeApp();
    mkdirSync(join(root, 'modules/auth/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/auth/index.ts'), "import { defineModule } from '@marmeon/core';\n\nexport default defineModule({ name: 'auth', migrations: new URL('./migrations/', import.meta.url) });\n");
    writeFileSync(join(root, 'modules/auth/migrations/2026_01_01_000000_create_permissions_table.ts'), STUB('permissions'));
    const { code, lines } = await publish(root, ['@acme/perm'], { module: 'auth' });
    expect(code).toBe(0);
    expect(lines).toContain('modules/auth/migrations/2026_01_01_000000_create_permissions_table.ts is there — skipped');
    expect(readdirSync(join(root, 'modules/auth/migrations'))).toHaveLength(2);
    expect(existsSync(join(root, 'modules/permissions'))).toBe(false);
  });

  it('takes the module from --module over the one of the package', async () => {
    const root = makeApp();
    expect((await publish(root, ['@acme/perm'], { module: 'billing' })).code).toBe(0);
    expect(readdirSync(join(root, 'modules'))).toEqual(['billing']);
  });

  it('puts a file that appears later into the module it made for the package, not the proposed one', async () => {
    const root = makeApp();
    expect((await publish(root, ['@acme/perm'], { module: 'billing' })).code).toBe(0);
    install(root, '@acme/perm', { ...PERM_FILES, 'stubs/migrations/create_grants_table.ts': STUB('permissions') });
    expect((await publish(root)).code).toBe(0);
    expect(readdirSync(join(root, 'modules/billing/migrations'))).toHaveLength(3);
    expect(readdirSync(join(root, 'modules'))).toEqual(['billing']);
  });

  it('uses an existing system module for a package of the framework, whose comment does not name the package', async () => {
    const root = makeApp({ name: '@marmeon/perm', module: 'system', files: { 'stubs/migrations/create_permissions_table.ts': STUB('permissions') } });
    mkdirSync(join(root, 'modules/system'), { recursive: true });
    expect((await publish(root, ['@marmeon/perm'])).code).toBe(0);
    expect(readdirSync(join(root, 'modules/system/migrations'))).toHaveLength(1);
  });

  it('never runs the entry of a package that declares no migrations, whatever providers it lists', async () => {
    const marker = join(tempDir('marmeon-publish-marker-'), 'ran');
    const root = makeApp();
    install(root, '@acme/other', {}, { declare: false, providers: ['OtherProvider'], entry: `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport class OtherProvider {}\n` });
    expect((await publish(root, [], { check: true })).code).toBe(0);
    expect((await publish(root)).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('reads the migrations of a package from its service provider and not from its package.json', async () => {
    const root = makeApp({ declare: false });
    const file = join(root, 'node_modules/@acme/perm/package.json');
    writeFileSync(file, JSON.stringify({ name: '@acme/perm', exports: './index.js', marmeon: { migrations: { format: 2, module: 'permissions', from: 'stubs/migrations' } } }));
    const { code, lines } = await publish(root);
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ @acme/perm ships no migrations.']);
    expect(written(root)).toEqual([]);
  });

  it('refuses a framework package under an npm alias, a path or a repository, which could be anything', async () => {
    for (const spec of ['npm:@acme/evil@1.0.0', 'NPM:@acme/evil@1.0.0', 'file:../evil', 'link:../evil', 'portal:../evil', 'workspace:*', 'github:acme/evil', 'evil/repo', 'https://example.com/evil.tgz', 'x.tgz', '../evil']) {
      const root = makeApp({ name: '@marmeon/perm', spec, module: 'system', files: { 'stubs/migrations/create_permissions_table.ts': STUB('permissions') } });
      mkdirSync(join(root, 'modules/system'), { recursive: true });
      const { code, lines } = await publish(root, ['@marmeon/perm']);
      expect(code, spec).toBe(1);
      expect(lines[0], spec).toContain("modules/system is your app's");
    }
  });

  it('accepts a framework package with a semver range, a dist-tag or catalog: for system', async () => {
    for (const spec of ['^1.2.0', '>=1.0.0 <2', 'latest', 'catalog:']) {
      const root = makeApp({ name: '@marmeon/perm', spec, module: 'system', files: { 'stubs/migrations/create_permissions_table.ts': STUB('permissions') } });
      mkdirSync(join(root, 'modules/system'), { recursive: true });
      expect((await publish(root, ['@marmeon/perm'])).code, spec).toBe(0);
    }
  });

  it('writes only the appended migration of a framework package into the system module that has the others', async () => {
    const root = makeApp({ name: '@marmeon/perm', module: 'system', files: { 'stubs/migrations/create_a_table.ts': STUB('a') } });
    mkdirSync(join(root, 'modules/system'), { recursive: true });
    expect((await publish(root, ['@marmeon/perm'])).code).toBe(0);
    install(root, '@marmeon/perm', { 'stubs/migrations/create_a_table.ts': STUB('a'), 'stubs/migrations/create_b_table.ts': STUB('a') }, { module: 'system', dependency: false });
    expect((await publish(root, ['@marmeon/perm'])).code).toBe(0);
    expect(readdirSync(join(root, 'modules/system/migrations')).map((file) => file.replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, ''))).toEqual(['create_a_table.ts', 'create_b_table.ts']);
  });

  it('ends green with nothing written for a kit app that has its only file in auth, with no owner line', async () => {
    const root = makeApp({ name: '@marmeon/auth', module: 'auth', files: { 'stubs/migrations/create_sign_ins_table.ts': STUB('sign-ins') } });
    mkdirSync(join(root, 'modules/auth/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/auth/migrations/0001_01_01_000006_create_sign_ins_table.ts'), 'export default {};\n');
    const { code, lines } = await publish(root, ['@marmeon/auth']);
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe('✓ Nothing to publish — every migration of @marmeon/auth is in your app');
    expect(written(root)).toEqual(['auth/migrations/0001_01_01_000006_create_sign_ins_table.ts']);
  });

  it('refuses a framework package whose package.json in node_modules says another name', async () => {
    const root = makeApp({ name: '@marmeon/perm', module: 'system', files: { 'stubs/migrations/create_permissions_table.ts': STUB('permissions') } });
    mkdirSync(join(root, 'modules/system'), { recursive: true });
    const file = join(root, 'node_modules/@marmeon/perm/package.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"name":"@marmeon/perm"', '"name":"@acme/evil"'));
    const { code, lines } = await publish(root, ['@marmeon/perm']);
    expect(code).toBe(1);
    expect(lines[0]).toContain("modules/system is your app's");
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

  it('looks for a package from the real path of an app root that is a symlink', async () => {
    const repo = tempDir('marmeon-publish-');
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '');
    const app = join(repo, 'apps/web');
    mkdirSync(join(app, 'bootstrap'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { '@acme/perm': '1.0.0' } }));
    writeFileSync(join(app, 'bootstrap/app.ts'), "import { defineApplication } from '@marmeon/core';\n\nexport default defineApplication({ root: '', modules: [] });\n");
    // A directory that is not the app's, with the package in its node_modules, holds the link.
    const elsewhere = makeApp();
    const link = join(elsewhere, 'link');
    symlinkSync(app, link);
    const refused = await publish(link);
    expect(refused.code).toBe(1);
    expect(refused.lines[0]).toBe('✗ @acme/perm is not installed in your app — install your dependencies first.');
    expect(written(app)).toEqual([]);
  });

  it('finds a package hoisted to the workspace root when the app is addressed through a symlink', async () => {
    const repo = makeApp();
    writeFileSync(join(repo, 'pnpm-lock.yaml'), '');
    const app = join(repo, 'apps/web');
    mkdirSync(join(app, 'bootstrap'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { '@acme/perm': '1.0.0' } }));
    writeFileSync(join(app, 'bootstrap/app.ts'), "import { defineApplication } from '@marmeon/core';\n\nexport default defineApplication({ root: '', modules: [] });\n");
    const link = join(tempDir('marmeon-publish-'), 'link');
    symlinkSync(app, link);
    const result = await publish(link);
    // Found: whatever comes after (the provider is resolved from the link, not from the repository) is not "not installed".
    expect(result.lines[0]).not.toMatch(/not installed/);
  });

  it.skipIf(process.platform === 'win32')('does not look above the app when the lockfile lies in a directory writable by everyone', async () => {
    const parent = makeApp();
    writeFileSync(join(parent, 'pnpm-lock.yaml'), '');
    chmodSync(parent, 0o777);
    const root = join(parent, 'apps/web');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@acme/perm': '1.0.0' } }));
    const { code, lines } = await publish(root);
    expect(code).toBe(1);
    expect(lines[0]).toBe('✗ @acme/perm is not installed in your app — install your dependencies first.');
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
      const root = makeApp({ declare: false, providers: ['X'] });
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines).toEqual(['✗ @acme/perm ships no migrations.']);
    });

    it('a declaration that is wrong, writing nothing', async () => {
      const root = makeApp({ from: 'stubs/missing' });
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines[0]).toContain('[marmeon:D21]');
      expect(written(root)).toEqual([]);
    });

    it('a --module that is no kebab-case name, writing nothing outside modules/', async () => {
      const root = makeApp();
      for (const module of ['../x', '..', 'a/b', 'Billing', '']) {
        await expect(publish(root, ['@acme/perm'], { module }), module).rejects.toMatchObject({
          name: 'CommandArgumentsError',
          message: '--module must be a kebab-case name: marmeon publish <package> --module=<name>',
        });
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

    it('an existing system module for a package from outside, unless --module names it', async () => {
      const root = makeApp({ module: 'system', files: { 'stubs/migrations/create_permissions_table.ts': STUB('permissions') } });
      mkdirSync(join(root, 'modules/system/migrations'), { recursive: true });
      writeFileSync(join(root, 'modules/system/migrations/2026_01_01_000000_create_users_table.ts'), 'export default {};\n');
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines).toEqual(["✗ modules/system is your app's — pass --module=<name> to put the tables of @acme/perm there, or another name."]);
      expect(readdirSync(join(root, 'modules/system/migrations'))).toHaveLength(1);
      expect((await publish(root, ['@acme/perm'], { module: 'system' })).code).toBe(0);
    });

    it('a migration of the app that has the name of a listed file: the module that holds it is named, not taken', async () => {
      const root = makeApp({ files: { 'stubs/migrations/create_invoices_table.ts': STUB('permissions'), 'stubs/migrations/create_spy_table.ts': STUB('permissions') }, module: 'spy' });
      mkdirSync(join(root, 'modules/billing/migrations'), { recursive: true });
      writeFileSync(join(root, 'modules/billing/migrations/2026_01_01_000000_create_invoices_table.ts'), 'export default {};\n');
      mkdirSync(join(root, 'modules/spy'));
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines[0]).toBe(ELSEWHERE('create_invoices_table', '@acme/perm', 'billing'));
      expect(readdirSync(join(root, 'modules/billing/migrations'))).toHaveLength(1);
    });

    it('a module of the app that holds a file of the package by name', async () => {
      const auth = makeApp({ module: 'auth', files: { 'stubs/migrations/create_users_table.ts': STUB('auth'), 'stubs/migrations/create_backdoor_table.ts': STUB('auth') } });
      mkdirSync(join(auth, 'modules/auth/migrations'), { recursive: true });
      writeFileSync(join(auth, 'modules/auth/migrations/2026_01_01_000000_create_users_table.ts'), 'export default {};\n');
      const refusedAuth = await publish(auth);
      expect(refusedAuth.code).toBe(1);
      expect(refusedAuth.lines[0]).toBe(ELSEWHERE('create_users_table', '@acme/perm', 'auth'));
      expect(readdirSync(join(auth, 'modules/auth/migrations'))).toHaveLength(1);

      const system = makeApp({ module: 'system', files: { 'stubs/migrations/create_cache_table.ts': STUB('cache'), 'stubs/migrations/create_backdoor_table.ts': STUB('cache') } });
      mkdirSync(join(system, 'modules/system/migrations'), { recursive: true });
      writeFileSync(join(system, 'modules/system/migrations/2026_01_01_000000_create_cache_table.ts'), 'export default {};\n');
      const refusedSystem = await publish(system);
      expect(refusedSystem.code).toBe(1);
      expect(refusedSystem.lines[0]).toBe(ELSEWHERE('create_cache_table', '@acme/perm', 'system'));
      expect(readdirSync(join(system, 'modules/system/migrations'))).toHaveLength(1);
    });

    it('a new migration of a framework package whose siblings sit in the starter kit\'s auth module, unless --module names it', async () => {
      const root = makeApp({ name: '@marmeon/auth', module: 'auth', files: { 'stubs/migrations/create_sign_ins_table.ts': STUB('sign-ins'), 'stubs/migrations/add_devices_table.ts': STUB('sign-ins') } });
      mkdirSync(join(root, 'modules/auth/migrations'), { recursive: true });
      writeFileSync(join(root, 'modules/auth/migrations/0001_01_01_000006_create_sign_ins_table.ts'), 'export default {};\n');
      const refused = await publish(root, ['@marmeon/auth']);
      expect(refused.code).toBe(1);
      expect(refused.lines[0]).toBe(ELSEWHERE('create_sign_ins_table', '@marmeon/auth', 'auth'));
      expect((await publish(root, ['@marmeon/auth'], { module: 'auth' })).code).toBe(0);
      expect(readdirSync(join(root, 'modules/auth/migrations'))).toHaveLength(2);
    });

    it('a file of the package in another module while it has a module of its own, even when nothing is missing', async () => {
      // @acme/b once shipped create_b2_table; it lies in modules/evil, whose package is no dependency any more.
      const root = makeApp({ name: '@acme/b', files: { 'stubs/migrations/create_b1_table.ts': STUB('b'), 'stubs/migrations/create_b2_table.ts': STUB('b') }, module: 'b' });
      expect((await publish(root, ['@acme/b'])).code).toBe(0);
      const [first, second] = readdirSync(join(root, 'modules/b/migrations'));
      rmSync(join(root, 'modules/b/migrations', second!));
      mkdirSync(join(root, 'modules/evil/migrations'), { recursive: true });
      writeFileSync(join(root, 'modules/evil/migrations/2026_01_01_000000_create_b2_table.ts'), 'export default {};\n');
      const refused = await publish(root, ['@acme/b']);
      expect(refused.code).toBe(1);
      expect(refused.lines).toEqual([ELSEWHERE('create_b2_table', '@acme/b', 'evil')]);
      expect(readdirSync(join(root, 'modules/b/migrations'))).toEqual([first]);

      // the files moved on, the index.ts with the line stayed: nothing missing, still refused
      const moved = makeApp();
      expect((await publish(moved)).code).toBe(0);
      mkdirSync(join(moved, 'modules/elsewhere/migrations'), { recursive: true });
      for (const file of readdirSync(join(moved, 'modules/permissions/migrations'))) renameSync(join(moved, 'modules/permissions/migrations', file), join(moved, 'modules/elsewhere/migrations', file));
      const stuck = await publish(moved);
      expect(stuck.code).toBe(1);
      expect(stuck.lines[0]).toContain('in modules/elsewhere, and @acme/perm ships one by that name');
    });

    it('a file name that another dependency of the app lists too, writing nothing', async () => {
      const root = makeApp({ files: { 'stubs/migrations/create_sessions_table.ts': STUB('permissions') } });
      install(root, '@marmeon/session', { 'stubs/migrations/create_sessions_table.ts': STUB('sessions') }, { module: 'system' });
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines).toEqual(['✗ @acme/perm and @marmeon/session both ship create_sessions_table — one name is one migration in an app, so they cannot both be published']);
      expect(written(root)).toEqual([]);
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
      const link = join(root, 'node_modules/@acme/perm/stubs/migrations/2026_01_01_000001_create_roles_table.ts');
      rmSync(link);
      symlinkSync(target, link);
      const { code } = await publish(root);
      expect(code).toBe(1);
      expect(written(root)).toEqual([]);
    });
  });
});

const run = (root: string) => new PackageMigrationsCheck({ root, providers: providersOf(root) } as unknown as Application).handle();
const FIRST = { 'stubs/migrations/create_one_table.ts': STUB('one') };
const SECOND = { 'stubs/migrations/create_two_table.ts': STUB('two') };

/** An app that depends on `@acme/one` (module `one`) and `@acme/two` (module `two`), neither published. */
function twoPackages(): string {
  const root = makeApp({ name: '@acme/one', module: 'one', files: FIRST });
  install(root, '@acme/two', SECOND, { module: 'two' });
  return root;
}

const migrationFiles = (root: string) => written(root).filter((path) => path.includes('/migrations/')).map((path) => path.replace(/^.*\//, ''));

describe('marmeon publish: updates, the order of files, several packages', () => {
  it('writes the file that a later release of the package appends, into the module that holds the others', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one') } });
    expect((await publish(root, ['@acme/one'])).code).toBe(0);
    install(root, '@acme/one', { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one'), 'stubs/migrations/create_c_table.ts': STUB('one') }, { module: 'one', dependency: false });
    const { code, lines } = await publish(root, ['@acme/one']);
    expect(code).toBe(0);
    expect(lines.filter((line) => line.startsWith('✓ Created'))).toEqual([expect.stringMatching(/modules\/one\/migrations\/.*_create_c_table\.ts$/)]);
    expect(readdirSync(join(root, 'modules/one/migrations'))).toHaveLength(3);
  });

  it('puts a copy behind the newest migration of the app', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one') } });
    mkdirSync(join(root, 'modules/billing/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/billing/migrations/2099_01_01_000000_create_invoices_table.ts'), 'export default {};\n');
    expect((await publish(root, ['@acme/one'])).code).toBe(0);
    expect(readdirSync(join(root, 'modules/one/migrations')).map((file) => file.slice(0, 17))).toEqual(['2099_01_01_000001', '2099_01_01_000002']);
  });

  it('refuses a file that is missing before one the app has, and writes nothing', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one') } });
    mkdirSync(join(root, 'modules/billing/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/billing/migrations/2026_01_01_000000_create_b_table.ts'), 'export default {};\n');
    for (const options of [{}, { module: 'billing' }]) {
      const { code, lines } = await publish(root, ['@acme/one'], options);
      expect(code).toBe(1);
      expect(lines).toEqual([
        '✗ create_one_table of @acme/one is not in your app, but create_b_table, which comes after it, is (modules/billing/migrations/2026_01_01_000000_create_b_table.ts). Copy 2026_01_01_000000_create_one_table.ts from node_modules/@acme/one into that module by hand, with a timestamp before create_b_table — with an empty up() if your app does not want it.',
      ]);
    }
    expect(written(root)).toEqual(['billing/migrations/2026_01_01_000000_create_b_table.ts']);
  });

  it('refuses both packages that ship the same name, with a package or from the choice, and writes nothing', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: FIRST });
    install(root, '@acme/two', FIRST, { module: 'two' });
    for (const name of ['@acme/one', '@acme/two']) {
      const other = name === '@acme/one' ? '@acme/two' : '@acme/one';
      const { code, lines } = await publish(root, [name]);
      expect(code).toBe(1);
      expect(lines).toEqual([`✗ ${name} and ${other} both ship create_one_table — one name is one migration in an app, so they cannot both be published`]);
    }
    const prompt = fakePrompt(false);
    const listed = await publish(root, [], {}, prompt);
    expect(listed.lines.filter((line) => line.includes('refused'))).toHaveLength(2);
    expect(listed.code).toBe(0);
    expect(written(root)).toEqual([]);
  });

  it('writes nothing for any package when one of the chosen is refused', async () => {
    const root = makeApp({ name: '@acme/one', module: 'shared', files: FIRST });
    install(root, '@acme/two', SECOND, { module: 'shared' });
    install(root, '@acme/three', { 'stubs/migrations/create_three_table.ts': STUB('three') }, { module: 'three' });
    const prompt = fakePrompt(true, (choices) => choices.map((_, index) => index));
    const { code, lines } = await publish(root, [], {}, prompt);
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ @acme/one and @acme/two would both create modules/shared — publish them one at a time, or pass --module=<name> for each.']);
    expect(written(root)).toEqual([]);
  });

  it('refuses a wrong call: two packages, --module without one', async () => {
    const root = twoPackages();
    await expect(publish(root, ['@acme/one', '@acme/two'])).rejects.toMatchObject({ name: 'CommandArgumentsError' });
    await expect(publish(root, [], { module: 'x' })).rejects.toMatchObject({
      name: 'CommandArgumentsError',
      message: '--module needs a package: marmeon publish <package> --module=<name>',
    });
    expect(written(root)).toEqual([]);
  });
});

describe('marmeon publish without a package', () => {
  it('writes only the package picked at a terminal', async () => {
    const root = twoPackages();
    const prompt = fakePrompt(true, () => [0]);
    const { code } = await publish(root, [], {}, prompt);
    expect(code).toBe(0);
    expect(prompt.asked).toEqual([{ question: 'Publish the migrations of which packages?', choices: ['@acme/one — not published (1)', '@acme/two — not published (1)'] }]);
    expect(migrationFiles(root).map((file) => file.slice(18))).toEqual(['create_one_table.ts']);
  });

  it('writes every package picked with one clock, a second apart', async () => {
    const root = twoPackages();
    const { code, lines } = await publish(root, [], {}, fakePrompt(true, (choices) => choices.map((_, index) => index)));
    expect(code).toBe(0);
    const stamps = migrationFiles(root).map((file) => file.slice(0, 17)).sort();
    expect(stamps).toHaveLength(2);
    expect(new Set(stamps).size).toBe(2);
    expect(lines.filter((line) => line.startsWith('Then:'))).toEqual(['Then: marmeon migrate']);
  });

  it('writes nothing for an empty answer', async () => {
    const root = twoPackages();
    const { code, lines } = await publish(root, [], {}, fakePrompt(true, () => []));
    expect(code).toBe(0);
    expect(lines).toEqual(['Nothing published']);
    expect(written(root)).toEqual([]);
  });

  it('lists what is missing without a terminal and ends with exit code 1, never asking', async () => {
    const root = twoPackages();
    const prompt = fakePrompt(false);
    const { code, lines } = await publish(root, [], {}, prompt);
    expect(code).toBe(1);
    expect(lines).toEqual(['@acme/one — not published (1)', '@acme/two — not published (1)', '✗ Choose on a terminal, or run marmeon publish <package> for each of them']);
    expect(prompt.asked).toEqual([]);
    expect(written(root)).toEqual([]);
  });

  it('ends with exit code 0 without a terminal when nothing is missing', async () => {
    const root = twoPackages();
    expect((await publish(root, ['@acme/one'])).code).toBe(0);
    expect((await publish(root, ['@acme/two'])).code).toBe(0);
    const { code, lines } = await publish(root, [], {}, fakePrompt(false));
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe('✓ Nothing to publish');
  });

  it('names a package that is partly there with what it lacks', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: FIRST });
    expect((await publish(root, ['@acme/one'])).code).toBe(0);
    install(root, '@acme/one', { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one') }, { module: 'one', dependency: false });
    const prompt = fakePrompt(true, () => []);
    await publish(root, [], {}, prompt);
    expect(prompt.asked[0]!.choices).toEqual(['@acme/one — lacks 1: create_b_table']);
  });
});

describe('marmeon publish --check', () => {
  it('leaves a package the app publishes nothing of out, and writes nothing', async () => {
    const root = twoPackages();
    const { code, lines } = await publish(root, [], { check: true });
    expect(code).toBe(0);
    expect(lines).toEqual(['✓ Every package you publish from has its migrations in your app']);
    expect(written(root)).toEqual([]);
  });

  it('fails when a package the app publishes from has a migration more, and writes nothing', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: FIRST });
    expect((await publish(root, ['@acme/one'])).code).toBe(0);
    install(root, '@acme/one', { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one') }, { module: 'one', dependency: false });
    const before = written(root);
    const { code, lines } = await publish(root, [], { check: true });
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ @acme/one lacks 1: create_b_table — marmeon publish @acme/one']);
    expect(written(root)).toEqual(before);
  });

  it('checks the package it is given, published from or not', async () => {
    const root = twoPackages();
    const { code, lines } = await publish(root, ['@acme/two'], { check: true });
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ @acme/two lacks 1: create_two_table — marmeon publish @acme/two writes it']);
    expect((await publish(root, ['@acme/two'])).code).toBe(0);
    expect((await publish(root, ['@acme/two'], { check: true })).code).toBe(0);
  });

  it('fails a package that is refused, when the app publishes from it, and prints the reason once', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one') } });
    expect((await publish(root, ['@acme/one'])).code).toBe(0);
    rmSync(join(root, 'modules/one/migrations', readdirSync(join(root, 'modules/one/migrations'))[0]!));
    const { code, lines } = await publish(root, [], { check: true });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^✗ create_one_table of @acme\/one is not in your app, but create_b_table/);
  });

  it('is not disturbed by an upgrade file no package ships', async () => {
    const root = makeApp({ name: '@marmeon/auth', module: 'auth', files: { 'stubs/migrations/create_sign_ins_table.ts': STUB('sign-ins') } });
    mkdirSync(join(root, 'modules/auth/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/auth/migrations/0001_01_01_000006_create_sign_ins_table.ts'), 'export default {};\n');
    writeFileSync(join(root, 'modules/auth/migrations/0001_01_01_000007_add_remember_columns_to_sign_ins.ts'), 'export default {};\n');
    expect((await publish(root, [], { check: true })).code).toBe(0);
    expect((await publish(root, ['@marmeon/auth'], { check: true })).code).toBe(0);
  });

  it('fails a package that is only installed, not a dependency', async () => {
    const root = makeApp({ dependency: false });
    expect((await publish(root, ['@acme/perm'], { check: true })).code).toBe(1);
  });
});

describe('the check package-migrations', () => {

  it('is named package-migrations and needs the app registered only', () => {
    expect([PackageMigrationsCheck.check, PackageMigrationsCheck.phase]).toEqual(['package-migrations', 'build']);
  });

  it('passes while nothing is published, names what a package lacks and passes again once it is published', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: FIRST });
    expect(await run(root)).toEqual([]);
    expect((await publish(root, ['@acme/one'])).code).toBe(0);
    expect(await run(root)).toEqual([]);
    install(root, '@acme/one', { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one') }, { module: 'one', dependency: false });
    expect(await run(root)).toEqual([
      { severity: 'error', code: 'D6', message: '@acme/one lacks create_b_table', fix: 'marmeon publish @acme/one', docs: 'docs/migrations.md#publishing-the-migrations-of-a-package' },
    ]);
    expect((await publish(root, ['@acme/one'])).code).toBe(0);
    expect(await run(root)).toEqual([]);
  });

  it('reports the reason when publish refuses a package the app publishes from', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one') } });
    expect((await publish(root, ['@acme/one'])).code).toBe(0);
    rmSync(join(root, 'modules/one/migrations', readdirSync(join(root, 'modules/one/migrations'))[0]!));
    expect(await run(root)).toMatchObject([{ severity: 'error', message: expect.stringMatching(/^create_one_table of @acme\/one is not in your app/) }]);
  });
});

describe('marmeon publish: what counts as the app\'s, what counts as used, what is printed', () => {
  const stamps = (root: string, module: string) => readdirSync(join(root, 'modules', module, 'migrations')).map((file) => file.slice(0, 17));

  it('goes behind a .js migration of the app as the migrator reads it, and counts a name the app has only as .mjs as there', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one') } });
    mkdirSync(join(root, 'modules/billing/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/billing/migrations/2099_01_01_000000_create_invoices_table.js'), 'export default {};\n');
    writeFileSync(join(root, 'modules/billing/migrations/2026_01_01_000000_create_one_table.mjs'), 'export default {};\n');
    const { code, lines } = await publish(root, ['@acme/one'], { module: 'one' });
    expect(code).toBe(0);
    expect(lines).toContain('modules/billing/migrations/2026_01_01_000000_create_one_table.mjs is there — skipped');
    expect(stamps(root, 'one')).toEqual(['2099_01_01_000001']);
  });

  it('does not take a migration of the app that has the name of a package for a sign it publishes from it', async () => {
    const root = makeApp({ name: 'innocent', module: 'widgets', files: { 'stubs/migrations/create_users_table.ts': STUB('x'), 'stubs/migrations/create_widgets_table.ts': STUB('x') } });
    mkdirSync(join(root, 'modules/accounts/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/accounts/migrations/2026_01_01_000000_create_users_table.ts'), 'export default {};\n');
    expect((await publish(root, [], { check: true })).code).toBe(0);
    expect(await run(root)).toEqual([]);
    expect(written(root)).toEqual(['accounts/migrations/2026_01_01_000000_create_users_table.ts']);
  });

  it('fails a package that publish made a module for when an update breaks its declaration', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: FIRST });
    expect((await publish(root, ['@acme/one'])).code).toBe(0);
    install(root, '@acme/one', FIRST, { module: 'one', from: 'stubs/missing', dependency: false });
    const { code, lines } = await publish(root, [], { check: true });
    expect(code).toBe(1);
    expect(lines[0]).toContain('[marmeon:D21]');
    expect(await run(root)).toMatchObject([{ severity: 'error', message: expect.stringContaining('D21') }]);
  });

  it('lists a package whose declaration cannot be read as refused, and does not check it unless publish made a module for it', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: FIRST, from: 'stubs/missing' });
    const { code, lines } = await publish(root, [], {});
    expect(code).toBe(0);
    expect(lines[0]).toBe('@acme/one — refused');
    expect(lines[1]).toContain('[marmeon:D21]');
    expect((await publish(root, [], { check: true })).code).toBe(0);
    expect(await run(root)).toEqual([]);
  });

  it('counts a package of the framework as used once one of its files is in system', async () => {
    const root = makeApp({ name: '@marmeon/perm', module: 'system', files: { 'stubs/migrations/create_a_table.ts': STUB('a') } });
    expect((await publish(root, [], { check: true })).code).toBe(0);
    expect((await publish(root, ['@marmeon/perm'])).code).toBe(0);
    install(root, '@marmeon/perm', { 'stubs/migrations/create_a_table.ts': STUB('a'), 'stubs/migrations/create_b_table.ts': STUB('a') }, { module: 'system', dependency: false });
    const { code, lines } = await publish(root, [], { check: true });
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ @marmeon/perm lacks 1: create_b_table — marmeon publish @marmeon/perm']);
  });

  it('checks a package of the framework installed by workspace:* once one of its files is in system', async () => {
    const root = makeApp({ name: '@marmeon/perm', module: 'system', spec: 'workspace:*', files: { 'stubs/migrations/create_a_table.ts': STUB('a') } });
    mkdirSync(join(root, 'modules/system/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/system/migrations/2026_01_01_000000_create_a_table.ts'), 'export default {};\n');
    expect((await publish(root, [], { check: true })).code).toBe(0);
    install(root, '@marmeon/perm', { 'stubs/migrations/create_a_table.ts': STUB('a'), 'stubs/migrations/create_b_table.ts': STUB('a') }, { module: 'system', dependency: false });
    const { code, lines } = await publish(root, [], { check: true });
    expect(code).toBe(1);
    // publish cannot open system for a workspace package without --module, so the answer is its refusal: red all the same
    expect(lines[0]).toContain('create_a_table in modules/system');
    expect(await run(root)).toMatchObject([{ severity: 'error' }]);
  });

  it('prints escapes in place of the control characters of a package.json that is no JSON', async () => {
    const root = makeApp();
    writeFileSync(join(root, 'node_modules/@acme/perm/package.json'), `x\u001b]8;;https://evil.test${String.fromCharCode(7)}\u202e`);
    for (const options of [{}, { check: true }]) {
      const { lines } = await publish(root, ['@acme/perm'], options);
      expect(lines.join('\n')).toContain('[marmeon:K7]');
      expect(lines.join('\n')).toContain('\\u001b]8;;http');
      expect(lines.join('\n')).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    }
    const listed = await publish(root, [], {});
    expect(listed.lines.join('')).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(listed.lines[0]).toBe('@acme/perm — refused');
  });

  it('refuses a newest timestamp that is no date, naming the file, and writes nothing', async () => {
    for (const stamp of ['2099_00_00_000000', '2099_13_01_000000', '2099_01_01_246000']) {
      const root = makeApp();
      mkdirSync(join(root, 'modules/billing/migrations'), { recursive: true });
      writeFileSync(join(root, `modules/billing/migrations/${stamp}_create_invoices_table.ts`), 'export default {};\n');
      const { code, lines } = await publish(root);
      expect(code, stamp).toBe(1);
      expect(lines, stamp).toEqual([`✗ modules/billing/migrations/${stamp}_create_invoices_table.ts has a timestamp that is no date, so a copy cannot be put behind it — rename it with a valid one.`]);
      expect(written(root)).toEqual([`billing/migrations/${stamp}_create_invoices_table.ts`]);
    }
  });

  it('refuses a newest timestamp that leaves no room behind it, and writes nothing', async () => {
    const root = makeApp();
    mkdirSync(join(root, 'modules/billing/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/billing/migrations/9999_12_31_235959_create_invoices_table.ts'), 'export default {};\n');
    const { code, lines } = await publish(root);
    expect(code).toBe(1);
    expect(lines[0]).toContain('has a timestamp that leaves no room behind it');
    expect(written(root)).toEqual(['billing/migrations/9999_12_31_235959_create_invoices_table.ts']);
  });

  it('names the files it wrote when a later write fails', async () => {
    const root = makeApp({ files: { 'stubs/migrations/create_a_table.ts': STUB('a'), 'stubs/migrations/create_b_table.ts': STUB('a') } });
    mkdirSync(join(root, 'modules/billing/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/billing/migrations/2099_01_01_000000_create_invoices_table.ts'), 'export default {};\n');
    const directory = join(root, 'modules/perm/migrations');
    const lines: string[] = [];
    const output = {
      success: (line = '') => {
        lines.push(line);
        // after the first file the directory takes no more
        if (line.startsWith('Created modules/perm/migrations')) chmodSync(directory, 0o555);
      },
      warn: (line = '') => lines.push(line),
      error: (line = '') => lines.push(line),
      line: (line = '') => lines.push(line),
    };
    try {
      await expect(commandOf(root).handle({ root, args: ['@acme/perm'], options: { module: 'perm' }, output, prompt: fakePrompt(false) } as unknown as CommandInput)).rejects.toThrow();
    } finally {
      chmodSync(directory, 0o755);
    }
    expect(lines).toContain('Written before it failed: modules/perm/index.ts, modules/perm/migrations/2099_01_01_000001_create_a_table.ts, bootstrap/app.ts');
  });
});

describe('marmeon publish: file names of the app on the terminal', () => {
  it('prints a path with control characters as escapes', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: { ...FIRST, 'stubs/migrations/create_b_table.ts': STUB('one') } });
    const directory = `bi${String.fromCharCode(27)}]8;;x${String.fromCharCode(7)}l${String.fromCharCode(0x202e)}`;
    mkdirSync(join(root, 'modules', directory, 'migrations'), { recursive: true });
    writeFileSync(join(root, 'modules', directory, 'migrations/2026_01_01_000000_create_one_table.ts'), 'export default {};\n');
    const { lines } = await publish(root, ['@acme/one'], { module: 'one' });
    expect(lines.join('\n')).toContain('modules/bi\\u001b]8;;x\\u0007l\\u202e/migrations/2026_01_01_000000_create_one_table.ts is there');
    expect(lines.join('')).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });
});

describe('marmeon publish: the declarations of service providers', () => {
  /** A provider that declares the directory `from` of the package installed at `dir`, whichever package exports it. */
  const declaring = (name: string, dir: string, module = 'system', from = 'stubs/migrations') => providerClass(name, { from: pathToFileURL(join(realpathSync(dir), from)), module });
  const permDir = (root: string) => join(root, 'node_modules/@acme/perm');

  it('only warns about a declaration in a package that does not claim it: the outcome, the exit and the files stay the same', async () => {
    for (const [args, options] of [[['@acme/perm'], {}], [['@acme/perm'], { check: true }], [[], { check: true }], [[], {}]] as const) {
      const clean = makeApp();
      const without = await publish(clean, [...args], options, fakePrompt(false));
      const root = makeApp();
      const Stranger = declaring('StrangerServiceProvider', permDir(root));
      const warned = await publish(root, [...args], options, fakePrompt(false), [Stranger]);
      expect(warned.code, JSON.stringify([args, options])).toBe(without.code);
      expect(written(root).length).toBe(written(clean).length);
      expect(warned.lines.filter((line) => !line.startsWith('! '))).toEqual(without.lines);
      expect(warned.lines.filter((line) => line.startsWith('! '))).toEqual([
        '! "StrangerServiceProvider" declares migrations in "stubs/migrations" of @acme/perm, which does not claim them: the package does not export that provider at its main entry.',
      ]);
    }
  });

  it('prints the class name of a provider that does not claim a declaration without its control characters', async () => {
    const root = makeApp();
    const { lines } = await publish(root, ['@acme/perm'], {}, fakePrompt(false), [declaring('Evil\u001b]8;;x\u0007\u202eServiceProvider', permDir(root))]);
    expect(lines.join('')).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(lines.join('')).toContain('\\u001b]8;;x\\u0007\\u202e');
  });

  it('says nothing about a declaration that lies in no package the app depends on, and publishes nothing for it', async () => {
    const root = makeApp({ declare: false });
    install(root, '@acme/deep', { 'stubs/migrations/create_deep_table.ts': STUB('deep') }, { dependency: false, declare: false });
    const Deep = declaring('DeepServiceProvider', join(root, 'node_modules/@acme/deep'));
    mkdirSync(join(root, 'modules/billing/migrations'), { recursive: true });
    const Mine = providerClass('AppServiceProvider', { from: pathToFileURL(join(realpathSync(root), 'modules/billing/migrations')), module: 'billing' });
    const { code, lines } = await publish(root, [], {}, fakePrompt(false), [Deep, Mine]);
    expect(code).toBe(0);
    expect(lines).toEqual(['✓ Nothing to publish']);
    expect(written(root)).toEqual([]);
  });

  it('gives a package that a dependency\'s provider points into no migrations to that dependency', async () => {
    const root = makeApp({ declare: false, name: '@acme/a' });
    install(root, '@acme/b', { 'stubs/migrations/create_b_table.ts': STUB('b') }, { dependency: false, declare: false });
    const Reexported = declaring('BServiceProvider', join(root, 'node_modules/@acme/b'), 'b');
    registry.set('a-exports', Reexported);
    writeFileSync(join(root, 'node_modules/@acme/a/index.js'), "export const provider = globalThis.__providersOfTest.get('a-exports');\n");
    const { code, lines } = await publish(root, ['@acme/a'], {}, fakePrompt(false), [Reexported]);
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ @acme/a ships no migrations.']);
    expect(written(root)).toEqual([]);
  });

  it('only warns about a declaration that cannot be read when no direct dependency exports its provider', async () => {
    const Broken = providerClass('BrokenServiceProvider', { from: 'stubs/migrations', module: 'x' });
    const root = makeApp();
    const listed = await publish(root, [], {}, fakePrompt(false), [Broken]);
    expect(listed.lines.filter((line) => line.startsWith('! '))).toEqual([expect.stringMatching(/^! \[marmeon:D21\] "BrokenServiceProvider" declares the migrations of its package wrongly/)]);
    expect((await publish(root, [], { check: true }, fakePrompt(false), [Broken])).code).toBe(0);
    expect((await publish(root, ['@acme/perm'], {}, fakePrompt(false), [Broken])).code).toBe(0);
    expect(written(root).length).toBeGreaterThan(0);
    const check = await new PackageMigrationsCheck({ root, providers: providersOf(root, [Broken]) } as unknown as Application).handle();
    expect(check).toEqual([{ severity: 'warning', message: expect.stringContaining('"BrokenServiceProvider"'), docs: 'docs/migrations.md#publishing-the-migrations-of-a-package' }]);
  });

  it('gives a declaration that cannot be read to the package that exports the provider: listed as refused, and failed only when the app publishes from it', async () => {
    const root = makeApp({ providers: ['PermServiceProvider'] });
    const permClass = () => providerClasses.get(permDir(root)) as unknown as { migrations: unknown };
    const good = permClass().migrations;
    permClass().migrations = { from: 'stubs/migrations', module: 'perm' };
    const listed = await publish(root, [], {});
    expect(listed.lines[0]).toBe('@acme/perm — refused');
    expect(listed.lines[1]).toContain('declares the migrations of its package wrongly');
    expect(listed.lines.filter((line) => line.startsWith('! '))).toEqual([]);
    // not published from: left out
    expect((await publish(root, [], { check: true })).code).toBe(0);
    expect(await run(root)).toEqual([]);

    // published from, and an update breaks the static: red
    permClass().migrations = good;
    expect((await publish(root, ['@acme/perm'])).code).toBe(0);
    permClass().migrations = { from: 'stubs/migrations', module: 'perm' };
    const check = await publish(root, [], { check: true });
    expect(check.code).toBe(1);
    expect(check.lines[0]).toContain('[marmeon:D21]');
    expect(await run(root)).toMatchObject([{ severity: 'error', message: expect.stringContaining('D21') }]);
  });

  it('warns, at the check, about a declaration no package claims', async () => {
    const root = makeApp();
    const Stranger = declaring('StrangerServiceProvider', permDir(root));
    const check = await new PackageMigrationsCheck({ root, providers: providersOf(root, [Stranger]) } as unknown as Application).handle();
    expect(check).toMatchObject([{ severity: 'warning', message: expect.stringContaining('does not claim them') }]);
  });

  it('imports the main entry of a package exactly when a declaration points into it', async () => {
    const dir = tempDir('marmeon-publish-marker-');
    const marker = (name: string) => `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, name))}, 'ran');\n`;
    const root = makeApp({ entry: marker('perm') });
    install(root, '@acme/quiet', {}, { declare: false, entry: marker('quiet') });
    expect((await publish(root, [], { check: true })).code).toBe(0);
    expect(existsSync(join(dir, 'perm'))).toBe(true);
    expect(existsSync(join(dir, 'quiet'))).toBe(false);
  });

  it('does not import a dependency that lists no providers to find the owner of a static that cannot be read', async () => {
    const dir = tempDir('marmeon-publish-marker-');
    const root = makeApp();
    install(root, '@acme/dev', {}, { declare: false, entry: `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, 'dev'))}, 'ran');\n` });
    const Broken = providerClass('BrokenServiceProvider', { from: 'stubs/migrations', module: 'x' });
    const { lines } = await publish(root, [], { check: true }, fakePrompt(false), [Broken]);
    expect(lines.filter((line) => line.startsWith('! '))).toHaveLength(1);
    expect(existsSync(join(dir, 'dev'))).toBe(false);
  });

  it('keeps reading the other packages when one cannot be read', async () => {
    const root = makeApp();
    install(root, '@acme/oddmain', { 'stubs/migrations/create_odd_table.ts': STUB('odd') });
    writeFileSync(join(root, 'node_modules/@acme/oddmain/package.json'), JSON.stringify({ name: '@acme/oddmain', main: 1 }));
    install(root, '@acme/deep', { 'stubs/migrations/create_deep_table.ts': STUB('deep') });
    const nested = '{"a":'.repeat(5000) + '1' + '}'.repeat(5000);
    writeFileSync(join(root, 'node_modules/@acme/deep/package.json'), `{"name":"@acme/deep","exports":${nested}}`);
    const listed = await publish(root, [], {});
    expect(listed.lines.filter((line) => line.startsWith('! '))).toHaveLength(2);
    expect((await publish(root, ['@acme/perm'])).code).toBe(0);
    expect(readdirSync(join(root, 'modules/permissions/migrations'))).toHaveLength(2);
  });

  it('refuses a package for which two providers declare, and writes nothing, not even for a choice of everything', async () => {
    const root = makeApp();
    const Second = declaring('SecondServiceProvider', permDir(root), 'other');
    registry.set('perm-second', Second);
    const first = join(root, 'node_modules/@acme/perm/index.js');
    writeFileSync(first, `${readFileSync(first, 'utf8')}export const second = globalThis.__providersOfTest.get('perm-second');\n`);
    const named = await publish(root, ['@acme/perm'], {}, fakePrompt(false), [Second]);
    expect(named.code).toBe(1);
    expect(named.lines[0]).toContain('declared by two service providers');
    const chosen = await publish(root, [], {}, fakePrompt(true, (choices) => choices.map((_, index) => index)), [Second]);
    expect(chosen.lines.join('\n')).toContain('declared by two service providers');
    expect(written(root)).toEqual([]);
  });

  it('gives a declaration to the package it lies in when another package of the app holds that directory too', async () => {
    const root = makeApp({ name: '@acme/outer', declare: false });
    const outer = join(root, 'node_modules/@acme/outer');
    const inner = join(outer, 'vendor/inner');
    mkdirSync(join(inner, 'stubs/migrations'), { recursive: true });
    writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: '@acme/inner', version: '1.0.0', exports: './index.js' }));
    writeFileSync(join(inner, 'stubs/migrations/2026_01_01_000000_create_inner_table.ts'), STUB('inner'));
    mkdirSync(join(root, 'node_modules/@acme'), { recursive: true });
    symlinkSync(inner, join(root, 'node_modules/@acme/inner'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@acme/outer': '1.0.0', '@acme/inner': '1.0.0' } }));
    const Provider = providerClass('InnerServiceProvider', { from: pathToFileURL(join(realpathSync(inner), 'stubs/migrations')), module: 'inner' });
    registry.set('shared-provider', Provider);
    const exported = "export const provider = globalThis.__providersOfTest.get('shared-provider');\n";
    writeFileSync(join(outer, 'index.js'), exported);
    writeFileSync(join(inner, 'index.js'), exported);

    // one pass over all dependencies: the directory belongs to the package that lies closest around it, though both export the provider
    const listed = await publish(root, [], {}, fakePrompt(false), [Provider]);
    expect(listed.lines).toEqual(['@acme/inner — not published (1)', '✗ Choose on a terminal, or run marmeon publish <package> for each of them']);
    const outerOnly = await publish(root, ['@acme/outer'], {}, fakePrompt(false), [Provider]);
    expect(outerOnly.lines).toEqual(['✗ @acme/outer ships no migrations.']);
    expect((await publish(root, ['@acme/inner'], {}, fakePrompt(false), [Provider])).code).toBe(0);
  });
});

describe('publishOwnMigrations: the make:*-table command of a package', () => {
  const ONE = { 'stubs/migrations/create_a_table.ts': STUB('a') };

  /** The directory of a package that is installed nowhere near the app: what a command passes as its package root. */
  function packageRoot(name: string, files: Record<string, string> = ONE): URL {
    const home = tempDir('marmeon-own-package-');
    writeFileSync(join(home, 'package.json'), JSON.stringify({ dependencies: {} }));
    install(home, name, files, { module: 'system', dependency: false });
    return pathToFileURL(`${join(home, 'node_modules', name)}/`);
  }

  /** The service provider the package at `source` declares its migrations on: what its command hands to `publishOwnMigrations`. */
  const providerAt = (source: URL): ServiceProviderClass =>
    (source.protocol === 'file:' ? providerClasses.get(fileURLToPath(source).replace(/\/$/, '')) : undefined) ?? providerClass('NoServiceProvider', undefined);

  async function own(root: string, source: URL, options: Record<string, unknown> = {}, Provider: ServiceProviderClass = providerAt(source), others: readonly ServiceProviderClass[] = []) {
    const lines: string[] = [];
    const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
    const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
    const code = await publishOwnMigrations({ root, args: [], options, output } as unknown as CommandInput, source, Provider, others);
    return { code, lines };
  }

  it('writes what the package ships, though the app does not list it, and ends with 0 once it is all there', async () => {
    const root = makeApp({ name: '@acme/other' });
    const source = packageRoot('@marmeon/a');
    const first = await own(root, source);
    expect(first.code).toBe(0);
    expect(readdirSync(join(root, 'modules/system/migrations'))).toHaveLength(1);
    expect(first.lines.at(-1)).toBe('Then: marmeon migrate');
    const second = await own(root, source);
    expect(second.code).toBe(0);
    expect(second.lines.at(-1)).toBe('✓ Nothing to publish — every migration of @marmeon/a is in your app');
    expect(readdirSync(join(root, 'modules/system/migrations'))).toHaveLength(1);
  });

  it('works in an app whose package.json is not there', async () => {
    const root = tempDir('marmeon-own-app-');
    expect((await own(root, packageRoot('@marmeon/a'))).code).toBe(0);
    expect(readdirSync(join(root, 'modules/system/migrations'))).toHaveLength(1);
  });

  it('writes only what is missing, behind the migrations the app has', async () => {
    const root = makeApp({ name: '@acme/other' });
    const source = packageRoot('@marmeon/a', { 'stubs/migrations/create_a_table.ts': STUB('a'), 'stubs/migrations/create_b_table.ts': STUB('b') });
    mkdirSync(join(root, 'modules/system/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/system/index.ts'), "import { defineModule } from '@marmeon/core';\n\nexport default defineModule({ name: 'system', migrations: new URL('./migrations/', import.meta.url) });\n");
    writeFileSync(join(root, 'modules/system/migrations/2099_01_01_000000_create_a_table.ts'), 'export default {};\n');
    expect((await own(root, source)).code).toBe(0);
    expect(readdirSync(join(root, 'modules/system/migrations'))).toEqual(['2099_01_01_000000_create_a_table.ts', '2099_01_01_000001_create_b_table.ts']);
  });

  it('opens a system module of an app that lists the package from the registry, and one that does not list it', async () => {
    for (const spec of ['^1.0.0', 'latest', undefined]) {
      const root = makeApp({ name: '@acme/other' });
      if (spec) writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@marmeon/a': spec } }));
      mkdirSync(join(root, 'modules/system'), { recursive: true });
      expect((await own(root, packageRoot('@marmeon/a'))).code).toBe(0);
      expect(readdirSync(join(root, 'modules/system/migrations')), String(spec)).toHaveLength(1);
    }
  });

  it('opens an existing system module of a workspace or tarball app, which publish opens only with --module=system', async () => {
    for (const spec of ['workspace:*', 'file:../marmeon-a-1.0.0.tgz', 'link:../a']) {
      const root = makeApp({ name: '@acme/other' });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@marmeon/a': spec } }));
      mkdirSync(join(root, 'modules/system'), { recursive: true });
      expect((await own(root, packageRoot('@marmeon/a'))).code, spec).toBe(0);
      expect(readdirSync(join(root, 'modules/system/migrations'))).toHaveLength(1);
    }
  });

  it('opens no existing module of the app but system, and system only for a package named @marmeon/…', async () => {
    const root = makeApp({ name: '@acme/other' });
    mkdirSync(join(root, 'modules/system'), { recursive: true });
    const refused = await own(root, packageRoot('@acme/a'));
    expect(refused.code).toBe(1);
    expect(refused.lines).toEqual(["✗ modules/system is your app's — pass --module=<name> to put the tables of @acme/a there, or another name."]);
    expect(written(root)).toEqual([]);
  });

  it('stops for a package.json of the app that is there but cannot be read', async () => {
    const root = makeApp({ name: '@acme/other' });
    writeFileSync(join(root, 'package.json'), '{ not json');
    const { code, lines } = await own(root, packageRoot('@marmeon/a'));
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ The package.json of your app cannot be read.']);
    expect(written(root)).toEqual([]);
  });

  it('neither reads nor writes marmeon-stubs.json: the package of a make command is not one the app can accept', async () => {
    const root = makeApp({ name: '@acme/other' });
    expect((await own(root, packageRoot('@marmeon/a'))).code).toBe(0);
    expect(existsSync(join(root, STUB_MANIFEST))).toBe(false);
    const broken = makeApp({ name: '@acme/other' });
    writeFileSync(join(broken, STUB_MANIFEST), '{ not json');
    const { code, lines } = await own(broken, packageRoot('@marmeon/a'));
    expect(code).toBe(0);
    expect(lines.filter((line) => line.startsWith('✗'))).toEqual([]);
    expect(readFileSync(join(broken, STUB_MANIFEST), 'utf8')).toBe('{ not json');
  });

  it('leaves a recorded, changed package alone, and copies one without a version', async () => {
    const root = makeApp({ name: '@acme/other' });
    const source = packageRoot('@marmeon/a');
    expect((await own(root, source)).code).toBe(0);
    const migration = readdirSync(join(root, 'modules/system/migrations'))[0]!;
    expect(recordStubSet(root, '@marmeon/a:stubs/migrations', { package: '@marmeon/a', version: '1.0.0', files: [{ path: `modules/system/migrations/${migration}`, stub: 'stubs/migrations/2026_01_01_000000_create_a_table.ts', sha256: stubHash('other') }] }).ok).toBe(true);
    const before = readFileSync(join(root, STUB_MANIFEST), 'utf8');
    const again = await own(root, source);
    expect(again.code).toBe(0);
    expect(again.lines.at(-1)).toBe('✓ Nothing to publish — every migration of @marmeon/a is in your app');
    expect(readFileSync(join(root, STUB_MANIFEST), 'utf8')).toBe(before);

    const versionless = packageRoot('@marmeon/b');
    const json = join(fileURLToPath(versionless), 'package.json');
    writeFileSync(json, JSON.stringify({ ...JSON.parse(readFileSync(json, 'utf8')), version: undefined }));
    const other = makeApp({ name: '@acme/other' });
    const { code, lines } = await own(other, versionless);
    expect(code).toBe(0);
    expect(lines.filter((line) => line.startsWith('!'))).toEqual([]);
    expect(existsSync(join(other, STUB_MANIFEST))).toBe(false);
  });

  it('refuses a package.json without a valid package name, and a root that is no file: URL', async () => {
    const root = makeApp({ name: '@acme/other' });
    for (const name of ['../x', '', 'a b', 5, undefined]) {
      const home = tempDir('marmeon-own-package-');
      writeFileSync(join(home, 'package.json'), JSON.stringify({ name }));
      const { code, lines } = await own(root, pathToFileURL(`${home}/`));
      expect(code, String(name)).toBe(1);
      expect(lines).toEqual(['✗ The package.json of the package that runs this command has no valid package name.']);
    }
    const remote = await own(root, new URL('https://example.com/pkg/'));
    expect(remote.code).toBe(1);
    expect(written(root)).toEqual([]);
  });

  it('creates a system module in a workspace app, which needs no opening', async () => {
    const root = makeApp({ name: '@acme/other' });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@marmeon/a': 'workspace:*' } }));
    expect((await own(root, packageRoot('@marmeon/a'))).code).toBe(0);
    expect(readdirSync(join(root, 'modules/system/migrations'))).toHaveLength(1);
  });

  it('refuses a module name that is no kebab-case name, and writes nothing', async () => {
    const root = makeApp({ name: '@acme/other' });
    const { code } = await own(root, packageRoot('@marmeon/a'), { module: '../x' });
    expect(code).toBe(1);
    expect(written(root)).toEqual([]);
    expect(existsSync(join(root, '..', 'x'))).toBe(false);
  });

  it('refuses a name another dependency of the app ships, and writes nothing', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: ONE });
    const { code, lines } = await own(root, packageRoot('@marmeon/a'), {}, undefined, providersOf(root));
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ @marmeon/a and @acme/one both ship create_a_table — one name is one migration in an app, so they cannot both be published']);
    expect(written(root)).toEqual([]);
  });

  it('still sees the collision with another dependency when a third package cannot be read, and prints what it could not read', async () => {
    const root = makeApp({ name: '@acme/one', module: 'one', files: ONE });
    install(root, '@acme/oddmain', { 'stubs/migrations/create_odd_table.ts': STUB('odd') });
    writeFileSync(join(root, 'node_modules/@acme/oddmain/package.json'), JSON.stringify({ name: '@acme/oddmain', main: 1 }));
    const { code, lines } = await own(root, packageRoot('@marmeon/a'), {}, undefined, providersOf(root));
    expect(code).toBe(1);
    expect(lines.filter((line) => line.startsWith('✗'))).toEqual(['✗ @marmeon/a and @acme/one both ship create_a_table — one name is one migration in an app, so they cannot both be published']);
    expect(lines.filter((line) => line.startsWith('! '))).toHaveLength(1);
    expect(written(root)).toEqual([]);
  });

  it('refuses a file that is missing before one the app has, and writes nothing', async () => {
    const root = makeApp({ name: '@acme/other' });
    mkdirSync(join(root, 'modules/billing/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/billing/migrations/2026_01_01_000000_create_b_table.ts'), 'export default {};\n');
    const source = packageRoot('@marmeon/a', { 'stubs/migrations/create_a_table.ts': STUB('a'), 'stubs/migrations/create_b_table.ts': STUB('b') });
    expect((await own(root, source)).code).toBe(1);
    expect(written(root)).toEqual(['billing/migrations/2026_01_01_000000_create_b_table.ts']);
  });

  it('keeps writing into the module it made for the package', async () => {
    const root = makeApp({ name: '@acme/other' });
    const source = packageRoot('@marmeon/a', { 'stubs/migrations/create_a_table.ts': STUB('a') });
    expect((await own(root, source, { module: 'billing' })).code).toBe(0);
    expect(readFileSync(join(root, 'modules/billing/index.ts'), 'utf8')).toContain('`marmeon publish @marmeon/a`');
    const again = await own(root, source);
    expect(again.code).toBe(0);
    expect(again.lines.at(-1)).toBe('✓ Nothing to publish — every migration of @marmeon/a is in your app');
  });

  it('refuses a provider whose directory lies outside the package whose command runs, and writes nothing', async () => {
    const root = makeApp({ name: '@acme/other' });
    const mine = packageRoot('@marmeon/a');
    const theirs = packageRoot('@marmeon/b', { 'stubs/migrations/create_b_table.ts': STUB('b') });
    const { code, lines } = await own(root, mine, {}, providerAt(theirs));
    expect(code).toBe(1);
    expect(lines).toEqual([`✗ @marmeon/a declares no migrations in its package: the static migrations of "${providerAt(theirs).name}" is missing or leads out of the package.`]);
    expect(written(root)).toEqual([]);
  });

  it('says so when the provider declares nothing', async () => {
    const root = makeApp({ name: '@acme/other' });
    const { code, lines } = await own(root, packageRoot('@marmeon/a'), {}, providerClass('EmptyServiceProvider', undefined));
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ @marmeon/a declares no migrations in its package: the static migrations of "EmptyServiceProvider" is missing or leads out of the package.']);
  });

  it('says so when the package.json of the package is not there', async () => {
    const root = makeApp({ name: '@acme/other' });
    const { code, lines } = await own(root, pathToFileURL(`${tempDir('marmeon-own-package-')}/`));
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ The package.json of the package that runs this command cannot be read.']);
  });
});

describe('marmeon publish: the record of what it published', () => {
  const PACKAGE = '@acme/perm';
  const SET = `${PACKAGE}:stubs/migrations`;
  const D27 = /@acme\/perm changed create_roles_table since you published it — /;
  const FILES = { 'stubs/migrations/create_permissions_table.ts': STUB('permissions'), 'stubs/migrations/create_roles_table.ts': STUB('roles') };
  const problemsOf = async (root: string) => (await run(root)) as readonly CheckProblem[];
  const manifestOf = (root: string) => {
    const read = readStubManifest(root);
    if (!read.ok) throw new Error(read.error.message);
    return read.value;
  };
  const release = (root: string, files: Record<string, string>, extra: { version?: string; from?: string } = {}) => {
    // A new release replaces the files of the old one, so the old timestamps are gone.
    rmSync(join(root, 'node_modules', PACKAGE, 'stubs'), { recursive: true, force: true });
    install(root, PACKAGE, files, { dependency: false, version: extra.version ?? '1.1.0', from: extra.from });
  };
  const changedRoles = { ...FILES, 'stubs/migrations/create_roles_table.ts': STUB('changed') };
  const rolesPath = (root: string) => join(root, 'modules/permissions/migrations', readdirSync(join(root, 'modules/permissions/migrations')).find((file) => file.endsWith('create_roles_table.ts'))!);
  const published = async (setup: Setup = {}) => {
    const root = makeApp({ files: FILES, ...setup });
    expect((await publish(root)).code).toBe(0);
    return root;
  };
  const errors = (lines: string[]) => lines.filter((line) => line.startsWith('✗'));
  const setVersion = (root: string, version: unknown) => {
    const file = join(root, 'node_modules', PACKAGE, 'package.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version }));
  };

  it('records every file it writes, with the hash of that package file and the version that wrote it', async () => {
    const root = await published();
    const set = manifestOf(root)!.sets[SET]!;
    expect(set.package).toBe(PACKAGE);
    expect(set.version).toBe('1.0.0');
    expect(Object.entries(set.files).map(([path, file]) => [path.replace(/\d{4}_\d{2}_\d{2}_\d{6}/, 'T'), file.stub.replace(/\d{4}_\d{2}_\d{2}_\d{6}/, 'T'), file.sha256])).toEqual([
      ['modules/permissions/migrations/T_create_permissions_table.ts', 'stubs/migrations/T_create_permissions_table.ts', stubHash(STUB('permissions'))],
      ['modules/permissions/migrations/T_create_roles_table.ts', 'stubs/migrations/T_create_roles_table.ts', stubHash(STUB('roles'))],
    ]);
    expect(stubHash(STUB('permissions'))).not.toBe(stubHash(STUB('roles')));
  });

  it('reports a recorded file the package changed as a warning that names the fix, never as an error', async () => {
    const root = await published();
    expect(await problemsOf(root)).toEqual([]);
    release(root, changedRoles);
    const problems = await problemsOf(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'warning', code: 'D27', message: expect.stringMatching(D27), docs: 'docs/migrations.md#publishing-the-migrations-of-a-package' });
    expect(problems[0]!.fix).toBeUndefined();
    expect(problems[0]!.message).toContain('marmeon publish @acme/perm --accept');
  });

  it('does not report the package file that is as it was published, nor the app editing its own copy', async () => {
    const root = await published();
    writeFileSync(rolesPath(root), 'export default { edited: true };\n');
    expect(await problemsOf(root)).toEqual([]);
    expect((await publish(root, [PACKAGE], { check: true })).code).toBe(0);
    release(root, FILES, { version: '1.0.1' });
    expect(await problemsOf(root)).toEqual([]);
  });

  it('judges no copy that has no record: an app published before the record gets one, for the files that equal the package', async () => {
    const root = await published();
    rmSync(join(root, STUB_MANIFEST));
    release(root, changedRoles);
    expect(await problemsOf(root)).toEqual([]);
    expect((await publish(root, [PACKAGE], { check: true })).code).toBe(0);
    expect((await publish(root)).code).toBe(0);
    const files = Object.keys(manifestOf(root)!.sets[SET]!.files);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/create_permissions_table\.ts$/);
    expect((await publish(root, [PACKAGE], { accept: true })).code).toBe(0);
    expect(Object.keys(manifestOf(root)!.sets[SET]!.files)).toHaveLength(2);
    expect(await problemsOf(root)).toEqual([]);
  });

  it('compares by the migration, so a copy the app moved to another module is still judged, also when no module says it is the package\'s', async () => {
    const root = await published();
    mkdirSync(join(root, 'modules/mine/migrations'), { recursive: true });
    renameSync(rolesPath(root), join(root, 'modules/mine/migrations/2026_02_02_020202_create_roles_table.ts'));
    writeFileSync(join(root, 'modules/permissions/index.ts'), 'export default {};\n');
    expect((await publish(root, [], { check: true })).code).toBe(0);
    release(root, changedRoles);
    const { code, lines } = await publish(root, [], { check: true });
    expect(code).toBe(1);
    expect(errors(lines)).toEqual([expect.stringMatching(/create_roles_table since you published it .*modules\/mine\/migrations\/2026_02_02_020202_create_roles_table\.ts/)]);
    expect(await problemsOf(root)).toMatchObject([{ severity: 'warning', code: 'D27', file: 'modules/mine/migrations/2026_02_02_020202_create_roles_table.ts' }]);
  });

  it('counts a package as used by its record when --module put its files into a module of the app', async () => {
    const root = makeApp({ files: FILES });
    mkdirSync(join(root, 'modules/billing'), { recursive: true });
    writeFileSync(join(root, 'modules/billing/index.ts'), "import { defineModule } from '@marmeon/core';\n\nexport default defineModule({ name: 'billing' });\n");
    expect((await publish(root, [PACKAGE], { module: 'billing' })).code).toBe(0);
    expect(readdirSync(join(root, 'modules/billing/migrations'))).toHaveLength(2);
    expect(await problemsOf(root)).toEqual([]);
    release(root, changedRoles);
    expect(await problemsOf(root)).toMatchObject([{ severity: 'warning', code: 'D27' }]);
    expect(errors((await publish(root, [], { check: true })).lines)).toEqual([expect.stringMatching(D27)]);
  });

  it('finds the record by the name of the migration, so a release that renumbers its files or moves its directory is still reported', async () => {
    const renumbered = await published();
    release(renumbered, { 'stubs/migrations/create_roles_table.ts': STUB('changed'), 'stubs/migrations/create_permissions_table.ts': STUB('permissions') });
    expect(await problemsOf(renumbered)).toMatchObject([{ severity: 'warning', code: 'D27' }]);
    expect(errors((await publish(renumbered, [PACKAGE], { check: true })).lines)).toEqual([expect.stringMatching(D27)]);

    const untouched = await published();
    release(untouched, { 'stubs/migrations/create_roles_table.ts': STUB('roles'), 'stubs/migrations/create_permissions_table.ts': STUB('permissions') });
    expect(await problemsOf(untouched)).toEqual([]);

    const moved = await published();
    release(moved, { 'stubs/db/create_permissions_table.ts': STUB('permissions'), 'stubs/db/create_roles_table.ts': STUB('changed') }, { from: 'stubs/db' });
    expect(await problemsOf(moved)).toMatchObject([{ severity: 'warning', code: 'D27' }]);
    expect((await publish(moved, [PACKAGE], { accept: true })).code).toBe(0);
    const sets = manifestOf(moved)!.sets;
    expect(Object.keys(sets[`${PACKAGE}:stubs/db`]!.files)).toHaveLength(2);
    expect(Object.keys(sets[SET]!.files)).toEqual([]);
    expect(await problemsOf(moved)).toEqual([]);
  });

  it('refuses to publish while a recorded file is changed, writes nothing, and writes the new file after --accept', async () => {
    const root = await published();
    release(root, { ...changedRoles, 'stubs/migrations/create_extra_table.ts': STUB('extra') });
    const before = readFileSync(join(root, STUB_MANIFEST), 'utf8');
    const files = written(root);
    const refused = await publish(root);
    expect(refused.code).toBe(1);
    expect(errors(refused.lines)).toEqual([expect.stringMatching(D27)]);
    expect(refused.lines[0]).toContain('[marmeon:D27]');
    expect(written(root)).toEqual(files);
    expect(readFileSync(join(root, STUB_MANIFEST), 'utf8')).toBe(before);

    expect((await publish(root, [PACKAGE], { accept: true })).code).toBe(0);
    expect(written(root)).toEqual(files);
    expect(manifestOf(root)!.sets[SET]).toMatchObject({ version: '1.1.0' });
    expect(Object.values(manifestOf(root)!.sets[SET]!.files).map((file) => file.sha256)).toEqual([stubHash(STUB('permissions')), stubHash(STUB('changed'))]);
    expect(await problemsOf(root)).toMatchObject([{ severity: 'error', code: 'D6' }]);

    expect((await publish(root)).code).toBe(0);
    expect(migrationFiles(root).filter((file) => file.endsWith('create_extra_table.ts'))).toHaveLength(1);
    expect(await problemsOf(root)).toEqual([]);
  });

  it('exits 1 from publish --check on a changed file, for the package and for all, until it is accepted', async () => {
    const root = await published();
    release(root, changedRoles);
    for (const args of [[PACKAGE], []]) {
      const { code, lines } = await publish(root, args, { check: true });
      expect(code).toBe(1);
      expect(errors(lines)).toEqual([expect.stringMatching(D27)]);
    }
    expect((await publish(root, [PACKAGE], { accept: true })).code).toBe(0);
    expect((await publish(root, [], { check: true })).code).toBe(0);
  });

  it('keeps the entries of earlier releases when a later release adds a file', async () => {
    const root = await published();
    release(root, { ...FILES, 'stubs/migrations/create_extra_table.ts': STUB('extra') });
    expect((await publish(root)).code).toBe(0);
    expect(Object.keys(manifestOf(root)!.sets[SET]!.files)).toHaveLength(3);
    expect(manifestOf(root)!.sets[SET]!.version).toBe('1.1.0');
  });

  describe('--accept', () => {
    it('takes one package and no other option', async () => {
      const root = await published();
      for (const [args, options] of [[[], {}], [[PACKAGE], { check: true }], [[PACKAGE], { module: 'x' }], [[PACKAGE], { only: 'migrations' }], [[PACKAGE], { force: true }]] as const) {
        await expect(publish(root, [...args], { accept: true, ...options })).rejects.toThrow(/--accept takes one package/);
      }
    });

    it('refuses a package that is no dependency and leaves the manifest as it was', async () => {
      const root = await published();
      install(root, '@acme/other', { 'stubs/migrations/create_other_table.ts': STUB('other') }, { dependency: false });
      const before = readFileSync(join(root, STUB_MANIFEST), 'utf8');
      const { code, lines } = await publish(root, ['@acme/other'], { accept: true });
      expect(code).toBe(1);
      expect(lines).toEqual(['✗ @acme/other is not a dependency of your app — add it first.']);
      expect(readFileSync(join(root, STUB_MANIFEST), 'utf8')).toBe(before);
    });

    it('says so when the app has none of the migrations, and when there is nothing to accept', async () => {
      const fresh = makeApp({ files: FILES });
      expect(await publish(fresh, [PACKAGE], { accept: true })).toEqual({ code: 1, lines: [`✗ Your app has none of the migrations of ${PACKAGE} — nothing to accept.`] });
      expect(existsSync(join(fresh, STUB_MANIFEST))).toBe(false);
      const root = await published();
      expect(await publish(root, [PACKAGE], { accept: true })).toEqual({ code: 0, lines: [`✓ Nothing to accept — ${STUB_MANIFEST} already records the migrations of ${PACKAGE} as they are`] });
    });

    it('leaves the manifest byte for byte as it was when the app has none of the migrations any more', async () => {
      const root = await published();
      const before = readFileSync(join(root, STUB_MANIFEST), 'utf8');
      rmSync(join(root, 'modules/permissions/migrations'), { recursive: true });
      expect(await publish(root, [PACKAGE], { accept: true })).toEqual({ code: 1, lines: [`✗ Your app has none of the migrations of ${PACKAGE} — nothing to accept.`] });
      expect(readFileSync(join(root, STUB_MANIFEST), 'utf8')).toBe(before);
    });

    it('refuses a package without a usable version, a manifest it cannot read and migrations it cannot read, writing nothing', async () => {
      const root = await published();
      const before = readFileSync(join(root, STUB_MANIFEST), 'utf8');
      const never = makeApp({ files: FILES });
      await publish(never);
      rmSync(join(never, STUB_MANIFEST));
      setVersion(never, undefined);
      const noVersion = `✗ ${PACKAGE} cannot be accepted: it has no version of the form 1.2.3, so marmeon-stubs.json cannot record its migrations.`;
      expect(await publish(never, [PACKAGE], { accept: true })).toEqual({ code: 1, lines: [noVersion] });
      setVersion(never, '1.2');
      expect(await publish(never, [PACKAGE], { accept: true })).toEqual({ code: 1, lines: [noVersion] });
      expect(existsSync(join(never, STUB_MANIFEST))).toBe(false);
      expect(readFileSync(join(root, STUB_MANIFEST), 'utf8')).toBe(before);

      writeFileSync(join(root, STUB_MANIFEST), '{ not json');
      expect(await publish(root, [PACKAGE], { accept: true })).toEqual({ code: 1, lines: ['✗ marmeon-stubs.json is not valid JSON. Nothing was written.'] });
      expect(readFileSync(join(root, STUB_MANIFEST), 'utf8')).toBe('{ not json');

      const unreadable = makeApp({ files: FILES, declare: false });
      expect(await publish(unreadable, [PACKAGE], { accept: true })).toEqual({ code: 1, lines: [`✗ ${PACKAGE} ships no migrations.`] });
    });
  });

  describe('a package that cannot be recorded', () => {
    const NOTE = (name: string, why: string) => `! ${name} ${why}, so its migrations are not recorded and a later change will not be noticed.`;

    it('is copied as before, with one line that says it is not recorded, and neither the check nor --check say more', async () => {
      for (const version of [undefined, '1.0', 'next']) {
        const root = makeApp({ files: FILES });
        setVersion(root, version);
        const { code, lines } = await publish(root);
        expect(code, String(version)).toBe(0);
        expect(lines.filter((line) => line.startsWith('!'))).toEqual([NOTE(PACKAGE, 'has no version of the form 1.2.3')]);
        expect(migrationFiles(root)).toHaveLength(2);
        expect(existsSync(join(root, STUB_MANIFEST))).toBe(false);
        expect(await problemsOf(root)).toEqual([]);
        expect(await publish(root, [], { check: true })).toEqual({ code: 0, lines: ['✓ Every package you publish from has its migrations in your app'] });
        expect((await publish(root, [PACKAGE], { check: true })).code).toBe(0);
      }
    });

    it('is copied, and not recorded, when its name is one that marmeon-stubs.json cannot hold, though it is found', async () => {
      const root = makeApp({ name: 'JSONStream-perm', files: FILES });
      const { code, lines } = await publish(root, ['JSONStream-perm']);
      expect(code).toBe(0);
      expect(lines.filter((line) => line.startsWith('!'))).toEqual([NOTE('JSONStream-perm', 'has a name marmeon-stubs.json cannot record')]);
      expect(migrationFiles(root)).toHaveLength(2);
      expect(existsSync(join(root, STUB_MANIFEST))).toBe(false);
    });
  });

  describe('sets that are not its own', () => {
    const kitSet = (root: string, key: string) => {
      mkdirSync(join(root, 'modules/auth'), { recursive: true });
      writeFileSync(join(root, 'modules/auth/x.ts'), 'export {};\n');
      expect(recordStubSet(root, key, { package: PACKAGE, version: '0.9.0', files: [{ path: 'modules/auth/x.ts', stub: 'stubs/modules/auth/x.ts' }] }).ok).toBe(true);
    };

    it('does not make a package used, and is neither read nor rewritten by publish, which records into a set of its own', async () => {
      const root = makeApp({ files: FILES });
      kitSet(root, `${PACKAGE}:stubs/modules/auth`);
      const kit = manifestOf(root)!.sets[`${PACKAGE}:stubs/modules/auth`];
      expect(await problemsOf(root)).toEqual([]);
      expect((await publish(root)).code).toBe(0);
      expect(manifestOf(root)!.sets[`${PACKAGE}:stubs/modules/auth`]).toEqual(kit);
      expect(Object.keys(manifestOf(root)!.sets[SET]!.files)).toHaveLength(2);
      release(root, changedRoles);
      expect(await problemsOf(root)).toMatchObject([{ severity: 'warning', code: 'D27' }]);
      expect((await publish(root, [PACKAGE], { accept: true })).code).toBe(0);
      expect(manifestOf(root)!.sets[`${PACKAGE}:stubs/modules/auth`]).toEqual(kit);
    });

    it('is left as it is when the set of the migrations directory also holds other files, and the migrations are copied unrecorded', async () => {
      const root = makeApp({ files: FILES });
      kitSet(root, SET);
      const before = readFileSync(join(root, STUB_MANIFEST), 'utf8');
      const { code, lines } = await publish(root);
      expect(code).toBe(0);
      expect(lines.filter((line) => line.startsWith('!'))).toEqual([expect.stringMatching(/^! @acme\/perm shares the set "@acme\/perm:stubs\/migrations" of marmeon-stubs\.json with files that are not migrations, so its migrations are not recorded/)]);
      expect(migrationFiles(root)).toHaveLength(2);
      expect(readFileSync(join(root, STUB_MANIFEST), 'utf8')).toBe(before);
    });
  });

  describe('what publish says without a package', () => {
    it('refuses with the manifest error before it lists anything, when marmeon-stubs.json cannot be read', async () => {
      const root = await published();
      writeFileSync(join(root, STUB_MANIFEST), JSON.stringify({ format: 2, sets: {} }));
      const { code, lines } = await publish(root, []);
      expect(code).toBe(1);
      expect(lines).toEqual([expect.stringMatching(/^✗ marmeon-stubs\.json was written by a newer Marmeon/)]);
    });

    it('does not call a package complete whose published migration changed: exit 1 with the same message as for the package', async () => {
      const root = await published();
      expect(await publish(root, [])).toEqual({ code: 0, lines: ['✓ Nothing to publish'] });
      release(root, changedRoles);
      const { code, lines } = await publish(root, []);
      expect(code).toBe(1);
      expect(lines).toEqual([expect.stringMatching(D27)]);
      expect(lines[0]).toContain('[marmeon:D27]');
    });

  });

  describe('which package counts as published from', () => {
    it('keeps a --module package when the app moved all its recorded migrations to another module', async () => {
      const root = makeApp({ files: FILES });
      mkdirSync(join(root, 'modules/billing'), { recursive: true });
      writeFileSync(join(root, 'modules/billing/index.ts'), "import { defineModule } from '@marmeon/core';\n\nexport default defineModule({ name: 'billing' });\n");
      expect((await publish(root, [PACKAGE], { module: 'billing' })).code).toBe(0);
      mkdirSync(join(root, 'modules/mine/migrations'), { recursive: true });
      for (const file of readdirSync(join(root, 'modules/billing/migrations'))) renameSync(join(root, 'modules/billing/migrations', file), join(root, 'modules/mine/migrations', file));
      release(root, changedRoles);
      expect(await problemsOf(root)).toMatchObject([{ severity: 'warning', code: 'D27', file: expect.stringMatching(/^modules\/mine\/migrations\//) }]);
    });

    it('counts a package whose declaration cannot be read as used by its record, so the check and --check say so', async () => {
      const root = await published({ providers: ['PermServiceProvider'] });
      const Provider = providerClasses.get(join(root, 'node_modules', PACKAGE))!;
      (Provider as unknown as { migrations: unknown }).migrations = { from: 'stubs/migrations', module: 'perm' };
      expect(await problemsOf(root)).toMatchObject([{ severity: 'error' }]);
      expect((await publish(root, [], { check: true })).code).toBe(1);
    });

    it('ends the record of a package that can no longer be recorded when it is accepted, and says so', async () => {
      const root = await published();
      setVersion(root, undefined);
      release(root, changedRoles, { version: 'next' });
      expect(await problemsOf(root)).toMatchObject([{ severity: 'warning', code: 'D27' }]);
      expect(await publish(root, [PACKAGE], { accept: true })).toEqual({ code: 0, lines: [`✓ ${PACKAGE} has no version of the form 1.2.3, so its migrations are no longer recorded in marmeon-stubs.json`] });
      expect(Object.keys(manifestOf(root)!.sets[SET]!.files)).toEqual([]);
      expect(await problemsOf(root)).toEqual([]);
    });

    it('keeps the record of a migration the app links to a file inside the project, so a later change is still reported', async () => {
      for (const accept of [false, true]) {
        const root = await published();
        mkdirSync(join(root, 'modules/real'), { recursive: true });
        const link = rolesPath(root);
        renameSync(link, join(root, 'modules/real/roles.ts'));
        symlinkSync(join(root, 'modules/real/roles.ts'), link);
        expect((await publish(root, [PACKAGE], accept ? { accept: true } : {})).code).toBe(0);
        expect(Object.keys(manifestOf(root)!.sets[SET]!.files)).toHaveLength(2);
        release(root, changedRoles);
        expect(await problemsOf(root), String(accept)).toMatchObject([{ severity: 'warning', code: 'D27' }]);
      }
    });

    it('takes the record that matches when one name is recorded in two sets', async () => {
      const root = await published();
      const [path] = Object.entries(manifestOf(root)!.sets[SET]!.files).find(([, file]) => file.stub.endsWith('create_roles_table.ts'))!;
      expect(recordStubSet(root, `${PACKAGE}:stubs/a-old`, { package: PACKAGE, version: '0.9.0', files: [{ path, stub: 'stubs/old/2025_01_01_000000_create_roles_table.ts', sha256: stubHash(STUB('stale')) }] }).ok).toBe(true);
      expect(await problemsOf(root)).toEqual([]);
      release(root, changedRoles);
      expect(await problemsOf(root)).toMatchObject([{ severity: 'warning', code: 'D27' }]);
    });
  });

  describe('a manifest that cannot be read', () => {
    it('refuses publish before it writes, and the check and --check report it once the app publishes from a package', async () => {
      const fresh = makeApp({ files: FILES });
      writeFileSync(join(fresh, STUB_MANIFEST), JSON.stringify({ format: 2, sets: {} }));
      const refused = await publish(fresh);
      expect(refused.code).toBe(1);
      expect(refused.lines).toEqual([expect.stringMatching(/^✗ marmeon-stubs\.json was written by a newer Marmeon.* Nothing was written\.$/)]);
      expect(written(fresh)).toEqual([]);

      const root = await published();
      writeFileSync(join(root, STUB_MANIFEST), JSON.stringify({ format: 2, sets: {} }));
      expect(await problemsOf(root)).toMatchObject([{ severity: 'error', file: STUB_MANIFEST, message: expect.stringMatching(/newer Marmeon/) }]);
      expect((await publish(root, [], { check: true })).code).toBe(1);
    });

    it('is an error as soon as a dependency declares migrations, published from or not; an app with none has nothing to say', async () => {
      const root = makeApp({ files: FILES });
      writeFileSync(join(root, STUB_MANIFEST), '{ not json');
      expect(await problemsOf(root)).toMatchObject([{ severity: 'error', file: STUB_MANIFEST, message: expect.stringContaining('not valid JSON') }]);
      expect((await publish(root, [], { check: true })).code).toBe(1);
      const none = makeApp({ files: FILES, declare: false });
      writeFileSync(join(none, STUB_MANIFEST), '{ not json');
      expect(await problemsOf(none)).toEqual([]);
    });
  });

  describe('a marmeon-stubs.json that is a link out of the app', () => {
    const outside = () => {
      const file = join(tempDir('marmeon-publish-outside-'), 'manifest.json');
      writeFileSync(file, '{ not json');
      return file;
    };
    const LEADS_OUT = /^marmeon-stubs\.json leads out of the project/;

    it('is refused by publish, --accept and --check, which read and write nothing through it', async () => {
      const root = makeApp({ files: FILES });
      const target = outside();
      symlinkSync(target, join(root, STUB_MANIFEST));
      const results = [await publish(root), await publish(root, [PACKAGE], { accept: true }), await publish(root, [PACKAGE], { check: true })];
      for (const { code, lines } of results) {
        expect(code).toBe(1);
        expect(lines).toEqual([expect.stringMatching(/^✗ marmeon-stubs\.json leads out of the project/)]);
      }
      expect(written(root)).toEqual([]);
      expect(readFileSync(target, 'utf8')).toBe('{ not json');
    });

    it('is an error of the check and of publish --check once the app publishes from a package', async () => {
      const root = await published();
      const target = outside();
      rmSync(join(root, STUB_MANIFEST));
      symlinkSync(target, join(root, STUB_MANIFEST));
      const problems = await problemsOf(root);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ severity: 'error', file: STUB_MANIFEST, message: expect.stringMatching(LEADS_OUT) });
      const { code, lines } = await publish(root, [], { check: true });
      expect(code).toBe(1);
      expect(lines).toEqual([expect.stringMatching(/^✗ marmeon-stubs\.json leads out of the project/)]);
      expect(readFileSync(target, 'utf8')).toBe('{ not json');
    });
  });
});
