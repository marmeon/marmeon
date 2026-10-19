import { chmodSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { PACKAGE_MIGRATIONS_READERS, readPackageMigrations } from './package-migrations.ts';

const PACKAGES = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__', 'formats', 'package-migrations');
const MARK = '// @marmeon-stub things 1\nexport default {};\n';

/** A package directory with the given files (marked as stubs) and the `marmeon` object of its package.json. */
function makePackage(marmeon: object, files: Record<string, string> = {}) {
  const dir = tempDir('marmeon-package-migrations-');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return { name: '@acme/things', dir, json: { marmeon } };
}

function read(migrations: unknown, files: Record<string, string> = { 'stubs/migrations/create_things_table.ts': MARK }) {
  return readPackageMigrations(makePackage({ migrations }, files));
}

const valid = { format: 1, module: 'things', files: ['stubs/migrations/create_things_table.ts'] };

function messageOf(result: ReturnType<typeof read>): string {
  if (result.ok) throw new Error('expected an error');
  return result.error.message;
}

describe('readPackageMigrations', () => {
  it('reads the format of every fixture', () => {
    const fixtures = readdirSync(FIXTURES);
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      const marmeon = JSON.parse(readFileSync(join(FIXTURES, fixture), 'utf8')) as { migrations: { files: string[]; module: string } };
      const files = Object.fromEntries(marmeon.migrations.files.map((path) => [path, MARK]));
      const result = readPackageMigrations(makePackage(marmeon, files));
      expect(result.ok, fixture).toBe(true);
      if (!result.ok || !result.value) continue;
      expect(result.value.module, fixture).toBe(marmeon.migrations.module);
      expect(result.value.files.map((file) => `stubs/migrations/${file.name}.ts`), fixture).toEqual(marmeon.migrations.files);
    }
  });

  it('returns the name, contents, set and revision of each file', () => {
    expect(read(valid)).toEqual({
      ok: true,
      value: { module: 'things', files: [{ name: 'create_things_table', contents: MARK, set: 'things', revision: 1 }] },
    });
  });

  it('has nothing to read without the field', () => {
    expect(readPackageMigrations(makePackage({ providers: ['X'] }))).toEqual({ ok: true, value: undefined });
    expect(readPackageMigrations({ name: '@acme/things', dir: tempDir('marmeon-package-migrations-'), json: {} })).toEqual({ ok: true, value: undefined });
  });

  describe('refuses', () => {
    const cases: [string, unknown, string][] = [
      ['a field that is no object', ['x'], '"migrations" must be an object'],
      ['a missing format', { module: 'things', files: valid.files }, 'it needs format: 1'],
      ['a format that is no number', { ...valid, format: '1' }, 'it needs format: 1'],
      ['a newer format', { ...valid, format: 2 }, 'newer Marmeon — update marmeon'],
      ['an unknown key', { ...valid, extra: true }, 'unknown key "extra"'],
      ['a missing module', { format: 1, files: valid.files }, 'it needs "module"'],
      ['a module that is no string', { ...valid, module: 7 }, 'it needs "module"'],
      ['a module with a parent segment', { ...valid, module: '../x' }, 'it needs "module"'],
      ['a module with a slash', { ...valid, module: 'a/b' }, 'it needs "module"'],
      ['a module in capitals', { ...valid, module: 'Things' }, 'it needs "module"'],
      ['a module of 65 characters', { ...valid, module: 'a'.repeat(65) }, 'at most 64 characters'],
      ['a module that is a device name', { ...valid, module: 'nul' }, 'it needs "module"'],
      ['a module that is a numbered device name', { ...valid, module: 'com1' }, 'it needs "module"'],
      ['more than 100 files', { ...valid, files: Array.from({ length: 101 }, (_, i) => `stubs/migrations/create_t${i}_table.ts`) }, 'more than 100 files'],
      ['no files', { format: 1, module: 'things' }, '"files" must be a non-empty array'],
      ['an empty list of files', { ...valid, files: [] }, '"files" must be a non-empty array'],
      ['a file that is no string', { ...valid, files: [3] }, '"files" must be a non-empty array'],
      ['an absolute path', { ...valid, files: ['/etc/hosts.ts'] }, 'relative path'],
      ['a drive path', { ...valid, files: ['C:/x/create_things_table.ts'] }, 'relative path'],
      ['a backslash', { ...valid, files: ['stubs\\migrations\\create_things_table.ts'] }, 'relative path'],
      ['a parent segment', { ...valid, files: ['stubs/../stubs/migrations/create_things_table.ts'] }, 'must not contain ".."'],
      ['a path out of the package', { ...valid, files: ['../elsewhere/create_things_table.ts'] }, 'must not contain ".."'],
      ['a current-directory segment', { ...valid, files: ['stubs/./migrations/create_things_table.ts'] }, 'must not contain ".."'],
      ['a name with a timestamp', { ...valid, files: ['stubs/migrations/2026_01_01_000000_create_things_table.ts'] }, 'plain migration name'],
      ['a name that is not TypeScript', { ...valid, files: ['stubs/migrations/create_things_table.js'] }, 'plain migration name'],
      ['a name with capitals', { ...valid, files: ['stubs/migrations/CreateThings.ts'] }, 'plain migration name'],
      ['the same name twice', { ...valid, files: [valid.files[0], 'stubs/other/create_things_table.ts'] }, 'listed twice'],
      ['a file that does not exist', { ...valid, files: ['stubs/migrations/create_other_table.ts'] }, 'does not exist in the package'],
    ];
    for (const [name, migrations, message] of cases) {
      it(name, () => {
        const text = messageOf(read(migrations, { 'stubs/migrations/create_things_table.ts': MARK, 'stubs/other/create_things_table.ts': MARK }));
        expect(text.startsWith('[marmeon:D21] @acme/things lists its migrations in package.json wrongly: ')).toBe(true);
        expect(text).toContain(message);
      });
    }

    it('a file without the stub mark', () => {
      expect(messageOf(read(valid, { 'stubs/migrations/create_things_table.ts': 'export default {};\n' }))).toContain('// @marmeon-stub <set> <revision>');
    });

    const marks: [string, string][] = [
      ['a set with an escape sequence', '// @marmeon-stub \x1b[31mred 1\n'],
      ['a set that is a path', '// @marmeon-stub ../x 1\n'],
      ['a revision of 0', '// @marmeon-stub things 0\n'],
      ['a revision beyond the safe integers', '// @marmeon-stub things 1e23\n'.replace('1e23', '100000000000000000000000')],
    ];
    for (const [name, contents] of marks) {
      it(`${name} in the stub mark`, () => {
        expect(messageOf(read(valid, { 'stubs/migrations/create_things_table.ts': contents }))).toContain('malformed stub mark');
      });
    }

    it('quotes a foreign string, cuts it and escapes control characters', () => {
      const text = messageOf(read({ ...valid, files: [`stubs/\x1b[31m\u0085${'x'.repeat(300)}/create_things_table.ts/..`] }));
      expect(text).not.toContain('\x1b');
      expect(text).not.toContain('\u0085');
      expect(text).toContain('\\u001b[31m\\u0085');
      expect(text.length).toBeLessThan(400);
    });

    it('a file larger than a megabyte', () => {
      expect(messageOf(read(valid, { 'stubs/migrations/create_things_table.ts': `${MARK}${' '.repeat(1 << 20)}` }))).toContain('larger than');
    });

    it('a file that cannot be read', () => {
      const pkg = makePackage({ migrations: valid }, { 'stubs/migrations/create_things_table.ts': MARK });
      chmodSync(join(pkg.dir, 'stubs/migrations/create_things_table.ts'), 0);
      if (process.getuid?.() === 0) return;
      expect(messageOf(readPackageMigrations(pkg))).toContain('cannot be read');
    });

    it('a directory in place of a file', () => {
      expect(messageOf(read(valid, { 'stubs/migrations/create_things_table.ts/inner.ts': MARK }))).toContain('is no file');
    });

    it('a symlink to a file outside the package', () => {
      const outside = tempDir('marmeon-package-migrations-outside-');
      writeFileSync(join(outside, 'evil.ts'), MARK);
      const pkg = makePackage({ migrations: { ...valid, files: ['stubs/migrations/evil.ts'] } }, { 'stubs/migrations/keep.txt': '' });
      symlinkSync(join(outside, 'evil.ts'), join(pkg.dir, 'stubs/migrations/evil.ts'));
      const text = messageOf(readPackageMigrations(pkg));
      expect(text).toContain('[marmeon:D21]');
      expect(text).toContain('leads out of the package');
    });

    it('a symlinked directory that leads outside the package', () => {
      const outside = tempDir('marmeon-package-migrations-outside-');
      writeFileSync(join(outside, 'create_things_table.ts'), MARK);
      const pkg = makePackage({ migrations: valid }, { 'stubs/keep.txt': '' });
      symlinkSync(outside, join(pkg.dir, 'stubs/migrations'));
      expect(messageOf(readPackageMigrations(pkg))).toContain('leads out of the package');
    });
  });

  it('accepts a directory whose name only begins with two dots', () => {
    const pkg = makePackage({ migrations: valid }, { '..shared/create_things_table.ts': MARK });
    mkdirSync(join(pkg.dir, 'stubs'));
    symlinkSync(join(pkg.dir, '..shared'), join(pkg.dir, 'stubs/migrations'));
    expect(readPackageMigrations(pkg).ok).toBe(true);
    const direct = makePackage({ migrations: { ...valid, files: ['..shared/create_things_table.ts'] } }, { '..shared/create_things_table.ts': MARK });
    expect(readPackageMigrations(direct).ok).toBe(true);
  });

  it('follows a symlink that stays inside the package', () => {
    const pkg = makePackage({ migrations: valid }, { 'shared/create_things_table.ts': MARK });
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
      const copied = [...source.matchAll(/stubs\/migrations\/([a-z_]+)\.ts/g)].map((match) => match[1]);
      expect(result.value.files.map((file) => file.name)).toEqual(copied);
    });
  }
});

describe('the readers of the format', () => {
  afterEach(() => {
    PACKAGE_MIGRATIONS_READERS.delete(2);
  });

  it('refuses a version after the newest it reads, and reads one that is registered', () => {
    const future = { ...valid, format: 2 };
    expect(messageOf(read(future))).toContain('newer Marmeon — update marmeon');
    PACKAGE_MIGRATIONS_READERS.set(2, (_pkg, field) => ({ ok: true, value: { module: String(field.module), files: [] } }));
    expect(read(future)).toEqual({ ok: true, value: { module: 'things', files: [] } });
    expect(messageOf(read({ ...valid, format: 3 }))).toContain('newer Marmeon');
    expect(read(valid).ok).toBe(true);
  });
});
