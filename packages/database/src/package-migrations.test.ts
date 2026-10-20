import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ServiceProviderClass } from '@marmeon/core';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { assignMigrations, migrationDeclarations, PACKAGE_MIGRATIONS_READERS, readPackageMigrations, readProviderMigrations, unattributedDeclarations } from './package-migrations.ts';
import type { MigrationDeclaration } from './package-migrations.ts';

const PACKAGES = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__', 'formats', 'package-migrations');
const STUB = 'export default {};\n';
const FIRST = 'stubs/migrations/2026_01_01_000000_create_things_table.ts';

/** A package directory with the given files and the `marmeon` object of its package.json. */
function makePackage(marmeon: object, files: Record<string, string> = {}) {
  const dir = tempDir('marmeon-package-migrations-');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return { name: '@acme/things', dir, json: { marmeon, exports: './index.js' } };
}

/** The providers a test package exports at its entry: the entry file hands out the very classes the test made. */
function entryOf(pkg: { dir: string }, ...providers: ServiceProviderClass[]): void {
  const registry = ((globalThis as { __providersOfTest?: Map<string, unknown> }).__providersOfTest ??= new Map<string, unknown>());
  const lines = providers.map((Provider, index) => {
    const key = `${pkg.dir}#${index}`;
    registry.set(key, Provider);
    return `export const provider${index} = globalThis.__providersOfTest.get(${JSON.stringify(key)});`;
  });
  if (existsSync(join(pkg.dir, 'index.js'))) throw new Error('entryOf: the package has an entry already');
  writeFileSync(join(pkg.dir, 'index.js'), `${lines.join('\n')}\nexport {};\n`);
}

function read(migrations: unknown, files: Record<string, string> = { [FIRST]: STUB }) {
  return readPackageMigrations(makePackage({ migrations }, files));
}

const valid = { format: 2, module: 'things', from: 'stubs/migrations' };

function messageOf(result: ReturnType<typeof read>): string {
  if (result.ok) throw new Error('expected an error');
  return result.error.message;
}

describe('readPackageMigrations', () => {
  // The files each fixture's package holds: the fixtures are JSON, so the test lays the directory out.
  const DIRECTORY: Record<string, string[]> = {
    'v2.json': ['2026_01_01_000100_create_roles_table.ts', '2026_01_01_000000_create_permissions_table.ts'],
    'v2-system.json': ['0001_01_01_000000_create_audit_table.ts'],
  };

  it('reads the format of every fixture that is current, and refuses the others', () => {
    const fixtures = readdirSync(FIXTURES);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      const marmeon = JSON.parse(readFileSync(join(FIXTURES, fixture), 'utf8')) as { migrations: { format: number; from?: string; module: string } };
      const names = DIRECTORY[fixture] ?? ['2026_01_01_000000_create_things_table.ts'];
      const from = marmeon.migrations.from ?? 'stubs/migrations';
      const result = readPackageMigrations(makePackage(marmeon, Object.fromEntries(names.map((name) => [`${from}/${name}`, STUB]))));
      if (marmeon.migrations.format === 1) {
        expect(messageOf(result), fixture).toContain('format 1 is no longer read: name the directory');
        continue;
      }
      expect(result.ok, fixture).toBe(true);
      if (!result.ok || !result.value) continue;
      expect(result.value.module, fixture).toBe(marmeon.migrations.module);
      expect(result.value.from, fixture).toBe(from);
      expect(result.value.files.map((file) => file.file), fixture).toEqual(names.map((name) => `${from}/${name}`).sort());
    }
  });

  it('refuses a format that is written for a newer Marmeon', () => {
    expect(messageOf(read({ ...valid, format: 3 }))).toContain('newer Marmeon — update marmeon');
  });

  it('returns the name without timestamp, the path and the contents of each file, sorted by file name', () => {
    const result = read(valid, {
      'stubs/migrations/2026_03_01_000000_create_c_table.ts': 'export default "c";',
      'stubs/migrations/2026_01_01_000000_create_a_table.ts': 'export default "a";',
      'stubs/migrations/2026_02_01_000000_create_b_table.ts': 'export default "b";',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        module: 'things',
        from: 'stubs/migrations',
        files: [
          { name: 'create_a_table', file: 'stubs/migrations/2026_01_01_000000_create_a_table.ts', contents: 'export default "a";' },
          { name: 'create_b_table', file: 'stubs/migrations/2026_02_01_000000_create_b_table.ts', contents: 'export default "b";' },
          { name: 'create_c_table', file: 'stubs/migrations/2026_03_01_000000_create_c_table.ts', contents: 'export default "c";' },
        ],
      },
    });
  });

  it('reads a migration with CRLF, a byte order mark and a comment block before the export, byte for byte', () => {
    const text = '\uFEFF/** Creates the things table.\r\n * Second line. */\r\nimport { defineMigration } from \'marmeon\';\r\n\r\nexport default defineMigration({ up() {}, down() {} });\r\n';
    const result = read(valid, { [FIRST]: text });
    expect(result.ok && result.value?.files[0]?.contents).toBe(text);
  });

  it('passes over a README and a sub-directory', () => {
    const result = read(valid, { [FIRST]: STUB, 'stubs/migrations/README.md': '# Notes', 'stubs/migrations/old/2020_01_01_000000_create_x_table.ts': STUB, 'stubs/migrations/notes.txt': '' });
    expect(result.ok && result.value?.files.map((file) => file.name)).toEqual(['create_things_table']);
  });

  it('has nothing to read without the field', () => {
    expect(readPackageMigrations(makePackage({ providers: ['X'] }))).toEqual({ ok: true, value: undefined });
    expect(readPackageMigrations({ name: '@acme/things', dir: tempDir('marmeon-package-migrations-'), json: {} })).toEqual({ ok: true, value: undefined });
  });

  describe('refuses', () => {
    const cases: [string, unknown, string, Record<string, string>?][] = [
      ['a field that is no object', ['x'], '"migrations" must be an object'],
      ['a missing format', { module: 'things', from: valid.from }, 'it needs format: 2'],
      ['a format that is no number', { ...valid, format: '2' }, 'it needs format: 2'],
      ['format 1', { format: 1, module: 'things', files: ['stubs/migrations/create_things_table.ts'] }, 'format 1 is no longer read: name the directory'],
      ['a newer format', { ...valid, format: 3 }, 'newer Marmeon — update marmeon'],
      ['an unknown key', { ...valid, extra: true }, 'unknown key "extra"'],
      ['the key files of format 1', { ...valid, files: [FIRST] }, 'unknown key "files"'],
      ['a missing module', { format: 2, from: valid.from }, 'it needs "module"'],
      ['a module that is no string', { ...valid, module: 7 }, 'it needs "module"'],
      ['a module with a parent segment', { ...valid, module: '../x' }, 'it needs "module"'],
      ['a module with a slash', { ...valid, module: 'a/b' }, 'it needs "module"'],
      ['a module in capitals', { ...valid, module: 'Things' }, 'it needs "module"'],
      ['a module of 65 characters', { ...valid, module: 'a'.repeat(65) }, 'at most 64 characters'],
      ['a module that is a device name', { ...valid, module: 'nul' }, 'it needs "module"'],
      ['a module that is a numbered device name', { ...valid, module: 'com1' }, 'it needs "module"'],
      ['a missing from', { format: 2, module: 'things' }, 'it needs "from"'],
      ['a from that is no string', { ...valid, from: ['stubs'] }, 'it needs "from"'],
      ['an empty from', { ...valid, from: '' }, 'relative path'],
      ['an absolute from', { ...valid, from: '/etc' }, 'relative path'],
      ['a drive path as from', { ...valid, from: 'C:x' }, 'relative path'],
      ['a backslash in from', { ...valid, from: 'stubs\\migrations' }, 'relative path'],
      ['a NUL in from', { ...valid, from: 'stubs\0/migrations' }, 'relative path'],
      ['a parent segment in from', { ...valid, from: 'stubs/../stubs/migrations' }, 'must not contain ".."'],
      ['a from out of the package', { ...valid, from: '..' }, 'must not contain ".."'],
      ['a current-directory segment in from', { ...valid, from: 'stubs/./migrations' }, 'must not contain ".."'],
      ['a trailing slash in from', { ...valid, from: 'stubs/migrations/' }, 'must not contain ".."'],
    ];
    for (const [name, migrations, message, files] of cases) {
      it(name, () => {
        const text = messageOf(read(migrations, files ?? { [FIRST]: STUB }));
        expect(text.startsWith('[marmeon:D21] @acme/things lists its migrations in package.json wrongly: ')).toBe(true);
        expect(text).toContain(message);
      });
    }

    it('quotes a foreign string, cuts it and escapes control characters', () => {
      const text = messageOf(read({ ...valid, from: `stubs/\x1b[31m\u0085${'x'.repeat(300)}/..` }));
      expect(text).not.toContain('\x1b');
      expect(text).not.toContain('\u0085');
      expect(text).toContain('\\u001b[31m\\u0085');
      expect(text.length).toBeLessThan(400);
    });

    it('escapes format and separator characters that reorder or hide text', () => {
      const text = messageOf(read({ ...valid, from: 'stubs/\u202e\u2028\u200b' }));
      expect(text).not.toMatch(/[\u202e\u2028\u200b]/);
      expect(text).toContain('\\u202e\\u2028\\u200b');
    });
  });
  it('accepts a directory whose name only begins with two dots', () => {
    const pkg = makePackage({ migrations: { ...valid, from: '..shared' } }, { '..shared/2026_01_01_000000_create_things_table.ts': STUB });
    expect(readPackageMigrations(pkg).ok).toBe(true);
  });
});

/** A service provider class that declares `migrations` as its static. */
function providerOf(migrations: unknown, name = 'ThingsServiceProvider'): ServiceProviderClass {
  const Provider = class {
    static migrations = migrations;
  };
  Object.defineProperty(Provider, 'name', { value: name });
  return Provider as unknown as ServiceProviderClass;
}

const declare = (...providers: ServiceProviderClass[]): MigrationDeclaration[] => migrationDeclarations(providers);

/** Reads the package through its `package.json` field. */
const FIELD = {
  name: 'the package.json field',
  prefix: '[marmeon:D21] @acme/things lists its migrations in package.json wrongly: ',
  build(files: Record<string, string>) {
    const pkg = makePackage({ migrations: valid }, files);
    return { dir: pkg.dir, read: () => readPackageMigrations(pkg) };
  },
};

/** Reads the package through the `static migrations` of its service provider. */
const PROVIDER = {
  name: 'static migrations',
  prefix: '[marmeon:D21] @acme/things declares the migrations it ships wrongly: ',
  build(files: Record<string, string>) {
    const pkg = makePackage({}, files);
    const Provider = providerOf({ from: pathToFileURL(join(pkg.dir, 'stubs/migrations')), module: 'things' });
    entryOf(pkg, Provider);
    return { dir: pkg.dir, read: () => readProviderMigrations(pkg, declare(Provider)) };
  },
};

// Both readers hand the directory to the same code, so every check of an entry runs through each of them.
describe.each([FIELD, PROVIDER])('the entries of the directory, read through $name', (reader) => {
  const refused = async (files: Record<string, string>, message: string) => {
    const text = messageOf(await reader.build(files).read());
    expect(text.startsWith(reader.prefix)).toBe(true);
    expect(text).toContain(message);
  };

  const cases: [string, string, Record<string, string>][] = [
    ['a file without a timestamp', 'must be named like a migration', { 'stubs/migrations/create_x.ts': STUB }],
    ['a name in capitals', 'must be named like a migration', { 'stubs/migrations/2026_01_01_000000_Create.ts': STUB }],
    ['a declaration file', 'must be named like a migration', { 'stubs/migrations/x.d.ts': STUB }],
    ['a timestamp of the wrong shape', 'must be named like a migration', { 'stubs/migrations/2026_1_1_000000_create_x.ts': STUB }],
    ['a name that starts with a digit', 'must be named like a migration', { 'stubs/migrations/2026_01_01_000000_1create.ts': STUB }],
    ['the same name under two timestamps', 'is in the directory twice', { [FIRST]: STUB, 'stubs/migrations/2026_02_01_000000_create_things_table.ts': STUB }],
    ['a directory that holds no migration', 'holds no migration', { 'stubs/migrations/README.md': '' }],
  ];
  for (const [name, message, files] of cases) it(`refuses ${name}`, async () => refused(files, message));

  it('refuses an empty directory', async () => {
    const { dir, read } = reader.build({ 'stubs/keep.txt': '' });
    mkdirSync(join(dir, 'stubs/migrations'), { recursive: true });
    expect(messageOf(await read())).toContain('holds no migration');
  });

  it('refuses more than 100 migrations', async () => {
    const files = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`stubs/migrations/2026_01_01_${String(i).padStart(6, '0')}_create_t${i}_table.ts`, STUB]));
    await refused(files, 'more than 100 migrations');
    delete files[Object.keys(files)[0]!];
    expect((await reader.build(files).read()).ok).toBe(true);
  });

  it('refuses a file larger than a megabyte', async () => {
    await refused({ [FIRST]: `${STUB}${' '.repeat(1 << 20)}` }, 'larger than');
  });

  it('refuses a file that cannot be read', async () => {
    const { dir, read } = reader.build({ [FIRST]: STUB });
    chmodSync(join(dir, FIRST), 0);
    if (process.getuid?.() === 0) return;
    expect(messageOf(await read())).toContain('cannot be read');
  });

  it.skipIf(process.platform === 'win32')('refuses a named pipe in place of a file, without waiting for a writer', async () => {
    const { dir, read } = reader.build({ 'stubs/keep.txt': '' });
    mkdirSync(join(dir, 'stubs/migrations'), { recursive: true });
    execFileSync('mkfifo', [join(dir, 'stubs/migrations/2026_01_01_000000_x.ts')]);
    expect(messageOf(await read())).toContain('is no file');
  });

  it('refuses a symlink to a file outside the package', async () => {
    const outside = tempDir('marmeon-package-migrations-outside-');
    writeFileSync(join(outside, 'evil.ts'), STUB);
    const { dir, read } = reader.build({ [FIRST]: STUB });
    symlinkSync(join(outside, 'evil.ts'), join(dir, 'stubs/migrations/2026_02_01_000000_create_evil_table.ts'));
    const text = messageOf(await read());
    expect(text).toContain('[marmeon:D21]');
    expect(text).toContain('leads out of the package');
  });

  it("refuses a file that holds no migration: another file's contents, binary data", async () => {
    const cases: [string, string][] = [
      ['npmrc', '//registry.npmjs.org/:_authToken=secret\n'],
      ['export', 'const x = 1;\n// export default\nexport const y = 2;\n'],
    ];
    for (const [label, contents] of cases) {
      const { dir, read } = reader.build({ [FIRST]: STUB });
      writeFileSync(join(dir, FIRST), contents);
      expect(messageOf(await read()), label).toContain('is no migration: it has no default export');
    }
  });

  it('refuses a file that is not valid UTF-8', async () => {
    const { dir, read } = reader.build({ [FIRST]: STUB });
    writeFileSync(join(dir, FIRST), Buffer.concat([Buffer.from('export default {};\n// '), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
    expect(messageOf(await read())).toContain('is not valid UTF-8');
    writeFileSync(join(dir, FIRST), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    expect(messageOf(await read())).toContain('is not valid UTF-8');
  });

  it('refuses a hard link inside the package to a file outside it, when the file is no migration', async () => {
    const outside = tempDir('marmeon-package-migrations-outside-');
    writeFileSync(join(outside, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n');
    const { dir, read } = reader.build({ 'stubs/keep.txt': '' });
    mkdirSync(join(dir, 'stubs/migrations'));
    linkSync(join(outside, '.npmrc'), join(dir, FIRST));
    expect(messageOf(await read())).toContain('has no default export');
  });

  it('refuses a symlink to a directory outside the package, named like a migration', async () => {
    const outside = tempDir('marmeon-package-migrations-outside-');
    const { dir, read } = reader.build({ [FIRST]: STUB });
    symlinkSync(outside, join(dir, 'stubs/migrations/2026_02_01_000000_create_evil_table.ts'));
    expect(messageOf(await read())).toContain('leads out of the package');
  });

  it('refuses a symlinked directory that leads outside the package', async () => {
    const outside = tempDir('marmeon-package-migrations-outside-');
    writeFileSync(join(outside, 'notes.ts'), STUB);
    const { dir, read } = reader.build({ 'stubs/keep.txt': '' });
    symlinkSync(outside, join(dir, 'stubs/migrations'));
    expect(messageOf(await read())).toContain('leads out of the package');
  });

  it('refuses a symlinked directory that is the package itself', async () => {
    const { dir, read } = reader.build({ 'stubs/keep.txt': '' });
    symlinkSync('..', join(dir, 'stubs/migrations'));
    expect(messageOf(await read())).toContain('leads out of the package');
  });

  it('refuses a directory that does not exist, and a file in its place', async () => {
    expect(messageOf(await reader.build({ 'stubs/keep.txt': '' }).read())).toContain('does not exist in the package');
    const { dir, read } = reader.build({ 'stubs/keep.txt': '' });
    writeFileSync(join(dir, 'stubs/migrations'), STUB);
    expect(messageOf(await read())).toContain('is no directory');
  });

  it('passes over a README and a sub-directory', async () => {
    const result = await reader.build({ [FIRST]: STUB, 'stubs/migrations/README.md': '# Notes', 'stubs/migrations/old/2020_01_01_000000_create_x_table.ts': STUB, 'stubs/migrations/notes.txt': '' }).read();
    expect(result.ok && result.value?.files.map((file) => file.name)).toEqual(['create_things_table']);
  });

  it('passes over a real directory whose name looks like a migration', async () => {
    const result = await reader.build({ [FIRST]: STUB, 'stubs/migrations/2026_02_01_000000_create_dir_table.ts/inner.ts': STUB }).read();
    expect(result.ok && result.value?.files.map((file) => file.name)).toEqual(['create_things_table']);
  });

  it('follows a symlink that stays inside the package', async () => {
    const { dir, read } = reader.build({ 'shared/2026_01_01_000000_create_things_table.ts': STUB });
    mkdirSync(join(dir, 'stubs'));
    symlinkSync(join(dir, 'shared'), join(dir, 'stubs/migrations'));
    const result = await read();
    expect(result.ok && result.value?.files.map((file) => file.name)).toEqual(['create_things_table']);
  });
});

describe('readProviderMigrations', () => {
  /** A package in a temp directory that ships one migration. */
  function shipping(name = '@acme/things', files: Record<string, string> = { [FIRST]: STUB }) {
    const pkg = makePackage({}, files);
    return { ...pkg, name };
  }
  const urlIn = (dir: string, path = 'stubs/migrations') => pathToFileURL(join(dir, path));
  /** Reads the package as the one that exports `providers` at its entry; `declared` are the providers the app boots. */
  const readFor = (pkg: ReturnType<typeof shipping>, exported: ServiceProviderClass[], declared: ServiceProviderClass[] = exported) => {
    entryOf(pkg, ...exported);
    return readProviderMigrations(pkg, declare(...declared));
  };
  const messageOfRead = async (pkg: ReturnType<typeof shipping>, ...providers: ServiceProviderClass[]) => messageOf(await readFor(pkg, providers));

  it('reads the files sorted, the directory relative to the package and the module', async () => {
    const pkg = shipping('@acme/things', {
      'stubs/migrations/2026_03_01_000000_create_c_table.ts': 'export default "c";',
      'stubs/migrations/2026_01_01_000000_create_a_table.ts': 'export default "a";',
    });
    expect(await readFor(pkg, [providerOf({ from: urlIn(pkg.dir), module: 'things' })])).toEqual({
      ok: true,
      value: {
        module: 'things',
        from: 'stubs/migrations',
        files: [
          { name: 'create_a_table', file: 'stubs/migrations/2026_01_01_000000_create_a_table.ts', contents: 'export default "a";' },
          { name: 'create_c_table', file: 'stubs/migrations/2026_03_01_000000_create_c_table.ts', contents: 'export default "c";' },
        ],
      },
    });
  });

  it('has nothing to read without a declaration', async () => {
    const pkg = shipping();
    expect(await readFor(pkg, [providerOf(undefined)])).toEqual({ ok: true, value: undefined });
    expect(await readProviderMigrations(pkg, [])).toEqual({ ok: true, value: undefined });
  });

  it('gives a declaration to the package whose directory it names, not to the package that lists the provider', async () => {
    const a = shipping('@acme/a');
    const b = shipping('@acme/b');
    const Reexported = providerOf({ from: urlIn(b.dir), module: 'things' }, 'BServiceProvider');
    // Both packages export the class: the one that lists it for the other re-exports it.
    entryOf(a, Reexported);
    entryOf(b, Reexported);
    const declarations = declare(Reexported);
    expect(await readProviderMigrations(a, declarations)).toEqual({ ok: true, value: undefined });
    const read = await readProviderMigrations(b, declarations);
    expect(read.ok && read.value?.module).toBe('things');
  });

  it('does not give a package what lies in a node_modules inside it, however the directory is written', async () => {
    const a = shipping('@acme/a', { 'keep.txt': '', 'node_modules/@acme/b/stubs/migrations/2026_01_01_000000_create_b_table.ts': STUB });
    const b = { name: '@acme/b', dir: join(a.dir, 'node_modules/@acme/b'), json: { exports: './index.js' } };
    const Provider = providerOf({ from: urlIn(a.dir, 'node_modules/@acme/b/stubs/migrations'), module: 'things' });
    entryOf(a, Provider);
    entryOf(b, Provider);
    const declarations = declare(Provider);
    expect(await readProviderMigrations(a, declarations)).toEqual({ ok: true, value: undefined });
    const read = await readProviderMigrations(b, declarations);
    expect(read.ok && read.value?.files.map((file) => file.name)).toEqual(['create_b_table']);
    const upper = providerOf({ from: urlIn(a.dir, 'Node_Modules/@acme/b/stubs/migrations'), module: 'things' });
    expect(await readProviderMigrations(a, declare(upper))).toEqual({ ok: true, value: undefined });
  });

  it('refuses a directory that is a symlink out of the package, for the package it lies in', async () => {
    const outside = tempDir('marmeon-package-migrations-outside-');
    writeFileSync(join(outside, '2026_01_01_000000_create_evil_table.ts'), STUB);
    const a = shipping('@acme/a', { 'stubs/keep.txt': '' });
    symlinkSync(outside, join(a.dir, 'stubs/migrations'));
    expect(await messageOfRead(a, providerOf({ from: urlIn(a.dir), module: 'things' }))).toContain('"stubs/migrations" leads out of the package.');
  });

  it('refuses a directory that is the package itself', async () => {
    const a = shipping();
    expect(await messageOfRead(a, providerOf({ from: pathToFileURL(a.dir), module: 'things' }))).toContain('leads out of the package');
  });

  it('knows a package by the directory the app reaches it through, when that is a symlink to it', async () => {
    const pkg = shipping();
    const linked = join(tempDir('marmeon-package-migrations-linked-'), 'linked');
    symlinkSync(pkg.dir, linked);
    const read = await readFor(pkg, [providerOf({ from: urlIn(linked), module: 'things' })]);
    expect(read.ok && read.value?.from).toBe('stubs/migrations');
  });

  it('counts the same declaration once, also when a subclass inherits it', async () => {
    const pkg = shipping();
    const Base = providerOf({ from: urlIn(pkg.dir), module: 'things' });
    const Derived = class extends (Base as unknown as new () => object) {} as unknown as ServiceProviderClass;
    const declarations = declare(Base, Derived);
    expect(declarations).toHaveLength(1);
    entryOf(pkg, Derived);
    expect((await readProviderMigrations(pkg, declarations)).ok).toBe(true);
  });

  it('counts a static that is a getter once, on the class and on a subclass', async () => {
    const pkg = shipping();
    const Base = class {
      static get migrations() {
        return { from: urlIn(pkg.dir), module: 'things' };
      }
    } as unknown as ServiceProviderClass;
    const Derived = class extends (Base as unknown as new () => object) {} as unknown as ServiceProviderClass;
    const declarations = declare(Base, Derived);
    expect(declarations).toHaveLength(1);
    entryOf(pkg, Base);
    expect((await readProviderMigrations(pkg, declarations)).ok).toBe(true);
  });

  it('refuses two different declarations for one package', async () => {
    const pkg = shipping();
    const text = await messageOfRead(pkg, providerOf({ from: urlIn(pkg.dir), module: 'things' }, 'AServiceProvider'), providerOf({ from: urlIn(pkg.dir), module: 'other' }, 'BServiceProvider'));
    expect(text).toContain('declared by two service providers: "AServiceProvider" and "BServiceProvider"');
  });

  describe('a provider the package does not export', () => {
    it('does not claim the directory of a package by naming it, and does not block that package', async () => {
      const b = shipping('@acme/b');
      const Legit = providerOf({ from: urlIn(b.dir), module: 'things' }, 'BServiceProvider');
      const Evil = providerOf({ from: urlIn(b.dir), module: 'system' }, 'EvilAServiceProvider');
      entryOf(b, Legit);
      const declarations = declare(Evil, Legit);
      const read = await readProviderMigrations(b, declarations);
      expect(read.ok && read.value?.module).toBe('things');
      // alone, the evil one gives b nothing
      expect(await readProviderMigrations(b, declare(Evil))).toEqual({ ok: true, value: undefined });
      const { unclaimed } = await assignMigrations([b], declarations);
      expect(unclaimed).toEqual(['"EvilAServiceProvider" declares migrations in "stubs/migrations" of @acme/b, which does not claim them: the package does not export that provider at its main entry.']);
    });

    it('is not claimed by a twin with an extra key, however it is listed', async () => {
      const b = shipping('@acme/b');
      const Legit = providerOf({ from: urlIn(b.dir), module: 'things' }, 'BServiceProvider');
      const Evil = providerOf({ from: urlIn(b.dir), module: 'things', extra: true }, 'EvilAServiceProvider');
      entryOf(b, Legit);
      const declarations = declare(Evil, Legit);
      expect(declarations).toHaveLength(2);
      const { results, unclaimed } = await assignMigrations([b], declarations);
      const read = results.get(b)!;
      expect(read.ok && read.value?.module).toBe('things');
      expect(unclaimed).toEqual([expect.stringContaining('"EvilAServiceProvider"')]);
    });

    it('is not merged with a declaration by a module that explains itself with toString', async () => {
      const b = shipping('@acme/b');
      let asked = 0;
      const module = {
        toString() {
          asked++;
          return 'things';
        },
      };
      const Legit = providerOf({ from: urlIn(b.dir), module: 'things' }, 'BServiceProvider');
      const Evil = providerOf({ from: urlIn(b.dir), module }, 'EvilAServiceProvider');
      entryOf(b, Legit);
      const declarations = declare(Evil, Legit);
      expect(declarations).toHaveLength(2);
      const { results, unclaimed } = await assignMigrations([b], declarations);
      expect(asked).toBe(0);
      const read = results.get(b)!;
      expect(read.ok && read.value?.module).toBe('things');
      expect(unclaimed).toHaveLength(1);
    });

    it('cannot make a package fail with a path that does not exist in it', async () => {
      const b = shipping('@acme/b');
      const Legit = providerOf({ from: urlIn(b.dir), module: 'things' }, 'BServiceProvider');
      const Evil = providerOf({ from: urlIn(b.dir, 'stubs/nothing'), module: 'things' }, 'EvilServiceProvider');
      entryOf(b, Legit);
      expect((await readProviderMigrations(b, declare(Evil, Legit))).ok).toBe(true);
    });

    it('is passed over in silence when it lies in no package the app publishes from (a typo, a path in the app)', async () => {
      const b = shipping('@acme/b');
      const Typo = providerOf({ from: pathToFileURL('/nowhere/stubs/migrations'), module: 'things' }, 'TypoServiceProvider');
      const Own = providerOf({ from: pathToFileURL(join(tempDir('marmeon-package-migrations-app-'), 'modules/x')), module: 'x' }, 'AppServiceProvider');
      const { results, unclaimed, passedOver } = await assignMigrations([b], declare(Typo, Own));
      expect(results.get(b)).toEqual({ ok: true, value: undefined });
      expect(unclaimed).toEqual([]);
      expect(passedOver).toEqual(['"TypoServiceProvider"', '"AppServiceProvider"']);
    });

    describe('when the entry of the package', () => {
      /** A package in a folder of its own, so that `../outside.mjs` is a file beside it. */
      function nested(exports: string) {
        const container = tempDir('marmeon-package-migrations-nested-');
        const dir = join(container, 'pkg');
        mkdirSync(join(dir, 'stubs/migrations'), { recursive: true });
        writeFileSync(join(dir, FIRST), STUB);
        const counter = { imports: 0 };
        (globalThis as { __entryImports?: typeof counter }).__entryImports = counter;
        writeFileSync(join(container, 'outside.mjs'), 'globalThis.__entryImports.imports++;\nexport {};\n');
        return { pkg: { name: '@acme/pkg', dir, json: { exports } }, container, counter };
      }
      const claim = (pkg: { dir: string }) => providerOf({ from: urlIn(pkg.dir), module: 'things' }, 'PkgServiceProvider');

      it('is outside it, nothing is imported and nothing claimed', async () => {
        const { pkg, counter } = nested('../outside.mjs');
        const { results, unclaimed } = await assignMigrations([pkg], declare(claim(pkg)));
        expect(counter.imports).toBe(0);
        expect(results.get(pkg)).toEqual({ ok: true, value: undefined });
        expect(unclaimed).toEqual([expect.stringContaining('its entry leads out of the package')]);
      });

      it('is a symlink out of it, nothing is imported', async () => {
        const { pkg, container, counter } = nested('./index.mjs');
        symlinkSync(join(container, 'outside.mjs'), join(pkg.dir, 'index.mjs'));
        const { unclaimed } = await assignMigrations([pkg], declare(claim(pkg)));
        expect(counter.imports).toBe(0);
        expect(unclaimed).toEqual([expect.stringContaining('its entry leads out of the package')]);
      });

      it('is in a node_modules of it, nothing is imported', async () => {
        const { pkg, container, counter } = nested('./node_modules/x/index.mjs');
        mkdirSync(join(pkg.dir, 'node_modules/x'), { recursive: true });
        writeFileSync(join(pkg.dir, 'node_modules/x/index.mjs'), 'globalThis.__entryImports.imports++;\nexport {};\n');
        void container;
        const { unclaimed } = await assignMigrations([pkg], declare(claim(pkg)));
        expect(counter.imports).toBe(0);
        expect(unclaimed).toEqual([expect.stringContaining('its entry leads out of the package')]);
      });

      it('throws when it is imported, the declaration is reported with that reason', async () => {
        const { pkg } = nested('./index.mjs');
        writeFileSync(join(pkg.dir, 'index.mjs'), "throw new Error('broken');\n");
        const { results, unclaimed } = await assignMigrations([pkg], declare(claim(pkg)));
        expect(results.get(pkg)).toEqual({ ok: true, value: undefined });
        expect(unclaimed).toEqual([expect.stringContaining('its entry could not be imported')]);
      });
    });
  });

  it('gives a declaration to the one package with the longest directory that holds it', async () => {
    const outer = shipping('@acme/outer', { 'keep.txt': '', 'packages/inner/stubs/migrations/2026_01_01_000000_create_inner_table.ts': STUB });
    const inner = { name: '@acme/inner', dir: join(outer.dir, 'packages/inner'), json: { exports: './index.js' } };
    const Provider = providerOf({ from: urlIn(inner.dir), module: 'things' });
    entryOf(outer, Provider);
    entryOf(inner, Provider);
    const { results, unclaimed } = await assignMigrations([outer, inner], declare(Provider));
    expect(results.get(outer)).toEqual({ ok: true, value: undefined });
    const read = results.get(inner)!;
    expect(read.ok && read.value?.files.map((file) => file.name)).toEqual(['create_inner_table']);
    expect(unclaimed).toEqual([]);
  });

  describe('a declaration that belongs to no package', () => {
    const cases: [string, () => unknown, string][] = [
      ['a string as from', () => ({ from: 'stubs/migrations', module: 'things' }), 'from must be a file: URL, such as'],
      ['an https URL', () => ({ from: new URL('https://example.com/stubs/migrations'), module: 'things' }), 'without a host, a query or a fragment'],
      ['a URL that is no file: URL and has no host', () => ({ from: new URL('data:,x'), module: 'things' }), 'without a host, a query or a fragment'],
      ['a file URL with a host', () => ({ from: new URL('file://host/x'), module: 'things' }), 'without a host, a query or a fragment'],
      ['a file URL with a query', () => ({ from: new URL('file:///tmp/x?x'), module: 'things' }), 'without a host, a query or a fragment'],
      ['a file URL with a fragment', () => ({ from: new URL('file:///tmp/x#x'), module: 'things' }), 'without a host, a query or a fragment'],
      ['an encoded slash', () => ({ from: new URL('file:///tmp/a%2Fb'), module: 'things' }), 'cannot be read'],
      ['no from', () => ({ module: 'things' }), 'from must be a file: URL, such as'],
      ['null', () => null, 'must be an object'],
      ['a string', () => 'stubs/migrations', 'must be an object'],
      ['an array', () => [], 'must be an object'],
      [
        'a getter that throws',
        () => ({
          get from(): URL {
            throw new Error('boom');
          },
          module: 'things',
        }),
        'cannot be read',
      ],
    ];
    for (const [name, make, message] of cases) {
      it(`names the class for ${name}`, async () => {
        const declarations = declare(providerOf(make(), 'EvilServiceProvider'));
        expect(declarations).toHaveLength(1);
        expect(declarations[0]!.ok).toBe(false);
        expect(unattributedDeclarations(declarations)).toEqual([expect.stringMatching(/^\[marmeon:D21\] "EvilServiceProvider" declares the migrations of its package wrongly: /)]);
        expect(unattributedDeclarations(declarations)[0]).toContain(message);
        expect(await readProviderMigrations(shipping(), declarations)).toEqual({ ok: true, value: undefined });
      });
    }

    it('names a provider whose static throws', () => {
      const Provider = class {
        static get migrations(): never {
          throw new Error('boom');
        }
      };
      Object.defineProperty(Provider, 'name', { value: 'ThrowingServiceProvider' });
      expect(unattributedDeclarations(declare(Provider as unknown as ServiceProviderClass))).toEqual([expect.stringContaining('"ThrowingServiceProvider"')]);
    });

    it('escapes control characters in the class name', () => {
      const [message] = unattributedDeclarations(declare(providerOf(null, 'Evil\x1b[31m‮Provider')));
      expect(message).not.toContain('\x1b');
      expect(message).not.toContain('‮');
      expect(message).toContain('\\u001b[31m\\u202e');
    });
  });

  describe('refuses', () => {
    const cases: [string, object, string][] = [
      ['an unknown key', { module: 'things', extra: true }, 'unknown key "extra"'],
      ['a missing module', {}, 'it needs "module"'],
      ['a module that is no string', { module: 7 }, 'it needs "module"'],
      ['a module with a parent segment', { module: '../x' }, 'it needs "module"'],
      ['a module in capitals', { module: 'Things' }, 'it needs "module"'],
      ['a module of 65 characters', { module: 'a'.repeat(65) }, 'at most 64 characters'],
      ['a module that is a device name', { module: 'nul' }, 'it needs "module"'],
    ];
    for (const [name, rest, message] of cases) {
      it(name, async () => {
        const pkg = shipping();
        const text = await messageOfRead(pkg, providerOf({ from: urlIn(pkg.dir), ...rest }));
        expect(text.startsWith('[marmeon:D21] @acme/things declares the migrations it ships wrongly: ')).toBe(true);
        expect(text).toContain(message);
      });
    }
  });

  it('reads each part of the static once, and uses the copy of the URL it checked', async () => {
    const pkg = shipping();
    const reads = { migrations: 0, from: 0, href: 0 };
    const real = urlIn(pkg.dir);
    const from = new Proxy(real, {
      get(target, property) {
        if (property === 'href') return ++reads.href === 1 ? target.href : 'file:///etc/';
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const value = {
      get from() {
        reads.from++;
        return from;
      },
      module: 'things',
    };
    const Provider = class {
      static get migrations() {
        reads.migrations++;
        return value;
      }
    };
    Object.defineProperty(Provider, 'name', { value: 'CountingServiceProvider' });
    const read = await readFor(pkg, [Provider as unknown as ServiceProviderClass]);
    expect(reads).toEqual({ migrations: 1, from: 1, href: 1 });
    expect(read.ok && read.value?.from).toBe('stubs/migrations');
  });
});

describe('the migrations the framework packages declare', () => {
  // The command of each package copies the stub named in its source, so the declaration must name the same file.
  const commands: Record<string, string> = {
    '@marmeon/cache': 'cache/src/commands/make-cache-table.ts',
    '@marmeon/session': 'session/src/commands/make-session-table.ts',
    '@marmeon/queue': 'queue/src/commands/failed.ts',
    '@marmeon/notifications': 'notifications/src/commands.ts',
    '@marmeon/storage': 'storage/src/uploads/commands.ts',
    '@marmeon/auth': 'auth/src/make-sign-ins-table.ts',
  };
  const packages = readdirSync(PACKAGES)
    .map((directory) => ({ directory, manifest: join(PACKAGES, directory, 'package.json') }))
    .flatMap(({ directory, manifest }) => {
      try {
        const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; marmeon?: { migrations?: unknown } };
        return json.marmeon?.migrations === undefined ? [] : [{ name: json.name, dir: join(PACKAGES, directory), json }];
      } catch {
        return [];
      }
    });

  it('are exactly those of the packages that have a make command', () => {
    expect(packages.map((pkg) => pkg.name).sort()).toEqual(Object.keys(commands).sort());
  });

  for (const pkg of packages) {
    it(`${pkg.name} lists the stub its make command copies, in the system module`, () => {
      const result = readPackageMigrations(pkg);
      expect(result.ok).toBe(true);
      if (!result.ok || !result.value) return;
      expect(result.value.module).toBe('system');
      const source = readFileSync(join(PACKAGES, commands[pkg.name]!), 'utf8');
      const copied = [...source.matchAll(/stubs\/migrations\/(0001_01_01_000000_[a-z_]+\.ts)/g)].map((match) => `stubs/migrations/${match[1]}`);
      expect(result.value.from).toBe('stubs/migrations');
      expect(result.value.files.map((file) => file.file)).toEqual(copied);
      const named = copied.map((file) => /_000000_([a-z_]+)\.ts$/.exec(file)![1]);
      expect(result.value.files.map((file) => file.name)).toEqual(named);
      // The command hands the root of its own package to publish: the URL leads from the command's file to the package directory.
      const root = /publishOwnMigrations\(input, new URL\('([./]+)', import\.meta\.url\)\)/.exec(source)?.[1];
      expect(root, 'the command publishes the migrations of its own package').toBeDefined();
      expect(fileURLToPath(new URL(root!, pathToFileURL(join(PACKAGES, commands[pkg.name]!))))).toBe(`${pkg.dir}/`);
    });
  }
});

describe('the readers of the format', () => {
  afterEach(() => {
    PACKAGE_MIGRATIONS_READERS.delete(3);
  });

  it('refuses a version after the newest it reads, and reads one that is registered', () => {
    const future = { ...valid, format: 3 };
    expect(messageOf(read(future))).toContain('newer Marmeon — update marmeon');
    PACKAGE_MIGRATIONS_READERS.set(3, (_pkg, field) => ({ ok: true, value: { module: String(field.module), from: String(field.from), files: [] } }));
    expect(read(future)).toEqual({ ok: true, value: { module: 'things', from: 'stubs/migrations', files: [] } });
    expect(messageOf(read({ ...valid, format: 4 }))).toContain('newer Marmeon');
    expect(read(valid).ok).toBe(true);
  });
});

describe('the migrations in the repository', () => {
  const ROOT = join(PACKAGES, '..');

  function listTs(directory: string): string[] {
    try {
      return (readdirSync(directory, { recursive: true }) as string[]).filter((file) => file.endsWith('.ts')).map((file) => join(directory, file));
    } catch {
      return [];
    }
  }

  const files = [
    ...readdirSync(PACKAGES).flatMap((name) => listTs(join(PACKAGES, name, 'stubs'))),
    ...readdirSync(join(ROOT, 'apps')).flatMap((name) => listTs(join(ROOT, 'apps', name, 'modules'))),
    ...listTs(join(PACKAGES, 'create-marmeon', 'template')),
  ].filter((file) => /[\\/]migrations[\\/]/.test(file));

  it('begin with no mark that tells a stub from a migration of the app', () => {
    expect(files.length).toBeGreaterThan(20);
    // Written in two parts so that a search for the mark finds no file at all.
    const mark = `// @marmeon${'-stub'}`;
    expect(files.filter((file) => readFileSync(file, 'utf8').startsWith(mark))).toEqual([]);
  });
});
