import { execFileSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { PACKAGE_MIGRATIONS_READERS, readPackageMigrations } from './package-migrations.ts';

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
  return { name: '@acme/things', dir, json: { marmeon } };
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
      ['a from that does not exist', { ...valid, from: 'stubs/other' }, 'does not exist in the package'],
      ['a from that is a file', { ...valid, from: FIRST }, 'is no directory'],
      ['a file without a timestamp', valid, 'must be named like a migration', { 'stubs/migrations/create_x.ts': STUB }],
      ['a name in capitals', valid, 'must be named like a migration', { 'stubs/migrations/2026_01_01_000000_Create.ts': STUB }],
      ['a declaration file', valid, 'must be named like a migration', { 'stubs/migrations/x.d.ts': STUB }],
      ['a timestamp of the wrong shape', valid, 'must be named like a migration', { 'stubs/migrations/2026_1_1_000000_create_x.ts': STUB }],
      ['a name that starts with a digit', valid, 'must be named like a migration', { 'stubs/migrations/2026_01_01_000000_1create.ts': STUB }],
      ['the same name under two timestamps', valid, 'is in the directory twice', { [FIRST]: STUB, 'stubs/migrations/2026_02_01_000000_create_things_table.ts': STUB }],
      ['a directory that holds no migration', valid, 'holds no migration', { 'stubs/migrations/README.md': '' }],
    ];
    for (const [name, migrations, message, files] of cases) {
      it(name, () => {
        const text = messageOf(read(migrations, files ?? { [FIRST]: STUB }));
        expect(text.startsWith('[marmeon:D21] @acme/things lists its migrations in package.json wrongly: ')).toBe(true);
        expect(text).toContain(message);
      });
    }

    it('an empty directory', () => {
      const pkg = makePackage({ migrations: valid });
      mkdirSync(join(pkg.dir, 'stubs/migrations'), { recursive: true });
      expect(messageOf(readPackageMigrations(pkg))).toContain('holds no migration');
    });

    it('more than 100 migrations', () => {
      const files = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`stubs/migrations/2026_01_01_${String(i).padStart(6, '0')}_create_t${i}_table.ts`, STUB]));
      expect(messageOf(read(valid, files))).toContain('more than 100 migrations');
      delete files[Object.keys(files)[0]!];
      expect(read(valid, files).ok).toBe(true);
    });

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

    it('a file larger than a megabyte', () => {
      expect(messageOf(read(valid, { [FIRST]: `${STUB}${' '.repeat(1 << 20)}` }))).toContain('larger than');
    });

    it('a file that cannot be read', () => {
      const pkg = makePackage({ migrations: valid }, { [FIRST]: STUB });
      chmodSync(join(pkg.dir, FIRST), 0);
      if (process.getuid?.() === 0) return;
      expect(messageOf(readPackageMigrations(pkg))).toContain('cannot be read');
    });

    it.skipIf(process.platform === 'win32')('a named pipe in place of a file, without waiting for a writer', () => {
      const pkg = makePackage({ migrations: valid });
      mkdirSync(join(pkg.dir, 'stubs/migrations'), { recursive: true });
      execFileSync('mkfifo', [join(pkg.dir, 'stubs/migrations/2026_01_01_000000_x.ts')]);
      expect(messageOf(readPackageMigrations(pkg))).toContain('is no file');
    });

    it('a symlink to a file outside the package', () => {
      const outside = tempDir('marmeon-package-migrations-outside-');
      writeFileSync(join(outside, 'evil.ts'), STUB);
      const pkg = makePackage({ migrations: valid }, { [FIRST]: STUB });
      symlinkSync(join(outside, 'evil.ts'), join(pkg.dir, 'stubs/migrations/2026_02_01_000000_create_evil_table.ts'));
      const text = messageOf(readPackageMigrations(pkg));
      expect(text).toContain('[marmeon:D21]');
      expect(text).toContain('leads out of the package');
    });

    it('a file that holds no migration: another file\'s contents, binary data, invalid UTF-8', () => {
      const cases: [string, Buffer | string][] = [
        ['npmrc', '//registry.npmjs.org/:_authToken=secret\n'],
        ['export', 'const x = 1;\n// export default\nexport const y = 2;\n'],
      ];
      for (const [label, contents] of cases) {
        const pkg = makePackage({ migrations: valid }, { [FIRST]: STUB });
        writeFileSync(join(pkg.dir, FIRST), contents);
        expect(messageOf(readPackageMigrations(pkg)), label).toContain('is no migration: it has no default export');
      }
    });

    it('a file that is not valid UTF-8', () => {
      const pkg = makePackage({ migrations: valid }, { [FIRST]: STUB });
      writeFileSync(join(pkg.dir, FIRST), Buffer.concat([Buffer.from('export default {};\n// '), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
      expect(messageOf(readPackageMigrations(pkg))).toContain('is not valid UTF-8');
      writeFileSync(join(pkg.dir, FIRST), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
      expect(messageOf(readPackageMigrations(pkg))).toContain('is not valid UTF-8');
    });

    it('a hard link inside the package to a file outside it, when the file is no migration', () => {
      const outside = tempDir('marmeon-package-migrations-outside-');
      writeFileSync(join(outside, '.npmrc'), '//registry.npmjs.org/:_authToken=secret\n');
      const pkg = makePackage({ migrations: valid }, { 'stubs/keep.txt': '' });
      mkdirSync(join(pkg.dir, 'stubs/migrations'));
      linkSync(join(outside, '.npmrc'), join(pkg.dir, FIRST));
      expect(messageOf(readPackageMigrations(pkg))).toContain('has no default export');
    });

    it('a symlink to a directory outside the package, named like a migration', () => {
      const outside = tempDir('marmeon-package-migrations-outside-');
      const pkg = makePackage({ migrations: valid }, { [FIRST]: STUB });
      symlinkSync(outside, join(pkg.dir, 'stubs/migrations/2026_02_01_000000_create_evil_table.ts'));
      expect(messageOf(readPackageMigrations(pkg))).toContain('leads out of the package');
    });

    it('a symlinked directory that leads outside the package', () => {
      const outside = tempDir('marmeon-package-migrations-outside-');
      writeFileSync(join(outside, 'notes.ts'), STUB);
      const pkg = makePackage({ migrations: valid }, { 'stubs/keep.txt': '' });
      symlinkSync(outside, join(pkg.dir, 'stubs/migrations'));
      expect(messageOf(readPackageMigrations(pkg))).toContain('leads out of the package');
    });

    it('a symlinked directory that is the package itself', () => {
      const pkg = makePackage({ migrations: valid }, { 'stubs/keep.txt': '' });
      symlinkSync('..', join(pkg.dir, 'stubs/migrations'));
      expect(messageOf(readPackageMigrations(pkg))).toContain('leads out of the package');
    });
  });

  it('passes over a real directory whose name looks like a migration', () => {
    const result = read(valid, { [FIRST]: STUB, 'stubs/migrations/2026_02_01_000000_create_dir_table.ts/inner.ts': STUB });
    expect(result.ok && result.value?.files.map((file) => file.name)).toEqual(['create_things_table']);
  });

  it('accepts a directory whose name only begins with two dots', () => {
    const pkg = makePackage({ migrations: { ...valid, from: '..shared' } }, { '..shared/2026_01_01_000000_create_things_table.ts': STUB });
    expect(readPackageMigrations(pkg).ok).toBe(true);
  });

  it('follows a symlink that stays inside the package', () => {
    const pkg = makePackage({ migrations: valid }, { 'shared/2026_01_01_000000_create_things_table.ts': STUB });
    mkdirSync(join(pkg.dir, 'stubs'));
    symlinkSync(join(pkg.dir, 'shared'), join(pkg.dir, 'stubs/migrations'));
    expect(readPackageMigrations(pkg).ok).toBe(true);
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
      const named = [...source.matchAll(/name: '([a-z_]+)'/g)].map((match) => match[1]);
      expect(result.value.files.map((file) => file.name)).toEqual(named);
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
