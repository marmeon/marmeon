import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandInput } from 'marmeon';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { PublishCommand } from './publish.ts';

const STUB = (set: string) => `// @marmeon-stub ${set} 1\nexport default {};\n`;
const ELSEWHERE = (file: string, pkg: string, where: string) =>
  `✗ ${file} of ${pkg} is in modules/${where}, which publish did not create for ${pkg} — if you put it there, pass --module=${where}; otherwise ${pkg} ships a migration with a name your app already uses.`;
const PERM_FILES = { 'stubs/migrations/create_permissions_table.ts': STUB('permissions'), 'stubs/migrations/create_roles_table.ts': STUB('permissions') };

const shipped = (index: number) => `2026_01_01_${String(index).padStart(6, '0')}`;

/** Writes a package into `<root>/node_modules`; `entry` is the source of its `index.js`, `providers` the names `marmeon.providers` lists. */
function install(root: string, name: string, files: Record<string, string>, extra: { module?: string; providers?: string[]; entry?: string; dependency?: boolean; spec?: string } = {}): void {
  const pkg = join(root, 'node_modules', name);
  mkdirSync(pkg, { recursive: true });
  const marmeon = { migrations: { format: 2, module: extra.module ?? 'permissions', from: 'stubs/migrations' }, ...(extra.providers ? { providers: extra.providers } : {}) };
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', exports: './index.js', marmeon }));
  writeFileSync(join(pkg, 'index.js'), extra.entry ?? '');
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
}

/** An app with `@acme/perm` in node_modules (and, by default, in its dependencies). */
function makeApp(setup: Setup = {}): string {
  const root = tempDir('marmeon-publish-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
  install(root, setup.name ?? '@acme/perm', setup.files ?? PERM_FILES, { module: setup.module, providers: setup.providers, entry: setup.entry, dependency: setup.dependency, spec: setup.spec });
  mkdirSync(join(root, 'bootstrap'));
  writeFileSync(join(root, 'bootstrap/app.ts'), "import { defineApplication } from '@marmeon/core';\n\nexport default defineApplication({ root: '', modules: [] });\n");
  return root;
}

async function publish(root: string, args: string[] = ['@acme/perm'], options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const code = await new PublishCommand().handle({ root, args, options, output } as unknown as CommandInput);
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

  it('skips a migration the app has already, such as one make:auth wrote, and writes the rest where --module says', async () => {
    const root = makeApp();
    mkdirSync(join(root, 'modules/auth/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/auth/index.ts'), "import { defineModule } from '@marmeon/core';\n\nexport default defineModule({ name: 'auth', migrations: new URL('./migrations/', import.meta.url) });\n");
    writeFileSync(join(root, 'modules/auth/migrations/2026_01_01_000000_create_roles_table.ts'), STUB('permissions'));
    const { code, lines } = await publish(root, ['@acme/perm'], { module: 'auth' });
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

  it('never runs the entry of the package, whatever providers it lists', async () => {
    const marker = join(tempDir('marmeon-publish-marker-'), 'ran');
    const root = makeApp({ providers: ['PermProvider'], entry: `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport class PermProvider {}\n` });
    expect((await publish(root)).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
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
      writeFileSync(file, JSON.stringify({ name: '@acme/perm', marmeon: { migrations: { format: 2, module: 'permissions', from: 'stubs/missing' } } }));
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

    it('a migration of the app without a stub mark that has the name of a listed file: the module that holds it is named, not taken', async () => {
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
      expect(stuck.lines[0]).toContain('is in modules/elsewhere, which publish did not create for @acme/perm');
    });

    it('a file name that another dependency of the app lists too, writing nothing', async () => {
      const root = makeApp({ files: { 'stubs/migrations/create_sessions_table.ts': STUB('permissions') } });
      install(root, '@marmeon/session', { 'stubs/migrations/create_sessions_table.ts': STUB('sessions') }, { module: 'system' });
      const { code, lines } = await publish(root);
      expect(code).toBe(1);
      expect(lines).toEqual(['✗ @acme/perm lists create_sessions_table, the name of a migration @marmeon/session lists too — it cannot publish it.']);
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
