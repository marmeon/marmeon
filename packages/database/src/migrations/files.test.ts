import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { migrationDirectories, migrationFiles, packageOfDirectory } from './files.ts';

const MIGRATION = '2026_10_01_120000_create_things_table.ts';

/** A directory with one migration file in it. */
function migrations(...segments: string[]): string {
  const directory = join(...segments);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, MIGRATION), 'export default {};\n');
  return directory;
}

const mod = (name: string, path: string | URL) => ({ name, migrations: path }) as ModuleDefinition;
const app = (root: string, ...modules: ModuleDefinition[]) => ({ root, modules }) as unknown as Pick<Application, 'root' | 'modules'>;

describe('packageOfDirectory', () => {
  it('names the package below the last node_modules', () => {
    const root = tempDir('marmeon-files-');
    expect(packageOfDirectory(migrations(root, 'node_modules', '@acme', 'perm', 'migrations'), root)).toBe('@acme/perm');
    expect(packageOfDirectory(migrations(root, 'node_modules', 'perm', 'migrations'), root)).toBe('perm');
    expect(packageOfDirectory(migrations(root, 'node_modules', '.pnpm', '@acme+perm@1.0.0', 'node_modules', '@acme', 'perm', 'migrations'), root)).toBe('@acme/perm');
  });

  it('ignores the segments of the app root and names that only start with node_modules', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'node_modules', 'app');
    mkdirSync(root, { recursive: true });
    expect(packageOfDirectory(migrations(root, 'modules', 'x', 'migrations'), root)).toBeUndefined();
    expect(packageOfDirectory(migrations(base, 'node_modules_old', 'perm', 'migrations'), root)).toBeUndefined();
  });

  it('matches the segment without regard to case', () => {
    const root = tempDir('marmeon-files-');
    expect(packageOfDirectory(join(root, 'Node_Modules', 'perm', 'migrations'), root)).toBe('perm');
  });
});

describe('migrationDirectories', () => {
  it('refuses a directory in node_modules with D20 and the package name', () => {
    const root = tempDir('marmeon-files-');
    const perm = mod('perm', migrations(root, 'node_modules', '@acme', 'perm', 'migrations'));
    expect(() => migrationDirectories(app(root, perm))).toThrow(/D20.*"@acme\/perm".*docs\/migrations\.md#migrations-from-a-package/s);
    expect(() => migrationFiles(app(root, perm))).toThrow(/D20/);
  });

  it('refuses a URL and a relative path into node_modules', () => {
    const root = tempDir('marmeon-files-');
    const directory = migrations(root, 'node_modules', 'perm', 'migrations');
    expect(() => migrationDirectories(app(root, mod('perm', pathToFileURL(directory))))).toThrow(/D20.*perm/s);
    expect(() => migrationDirectories(app(root, mod('perm', './node_modules/perm/migrations')))).toThrow(/D20/);
  });

  it('refuses a pnpm layout', () => {
    const root = tempDir('marmeon-files-');
    const directory = migrations(root, 'node_modules', '.pnpm', '@acme+perm@1.0.0', 'node_modules', '@acme', 'perm', 'migrations');
    expect(() => migrationDirectories(app(root, mod('perm', directory)))).toThrow(/D20.*@acme\/perm/s);
  });

  it('refuses a module directory that is a symlink into node_modules', () => {
    const root = tempDir('marmeon-files-');
    const target = migrations(root, 'node_modules', '@acme', 'perm', 'migrations');
    mkdirSync(join(root, 'modules', 'x'), { recursive: true });
    symlinkSync(target, join(root, 'modules', 'x', 'migrations'));
    expect(() => migrationDirectories(app(root, mod('x', 'modules/x/migrations')))).toThrow(/D20.*@acme\/perm/s);
  });

  it('allows a workspace package outside the root, also when node_modules links to it', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'apps', 'app');
    mkdirSync(join(root, 'node_modules', '@acme'), { recursive: true });
    const workspace = migrations(base, 'packages', 'perm', 'migrations');
    symlinkSync(join(base, 'packages', 'perm'), join(root, 'node_modules', '@acme', 'perm'));
    const viaLink = join(root, 'node_modules', '@acme', 'perm', 'migrations');
    for (const path of [workspace, viaLink]) {
      expect(migrationFiles(app(root, mod('perm', path))).map((file) => file.module)).toEqual(['perm']);
    }
  });

  it('refuses a migration file that is a symlink into node_modules', () => {
    const root = tempDir('marmeon-files-');
    const target = migrations(root, 'node_modules', '@acme', 'perm', 'migrations');
    const directory = join(root, 'modules', 'x', 'migrations');
    mkdirSync(directory, { recursive: true });
    symlinkSync(join(target, MIGRATION), join(directory, MIGRATION));
    expect(() => migrationFiles(app(root, mod('x', directory)))).toThrow(/D20.*@acme\/perm/s);
  });

  it('refuses a package hoisted to the root of a monorepo', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'apps', 'app');
    mkdirSync(root, { recursive: true });
    const directory = migrations(base, 'node_modules', '@acme', 'perm', 'migrations');
    expect(() => migrationDirectories(app(root, mod('perm', directory)))).toThrow(/D20.*@acme\/perm/s);
  });

  it('checks the whole path of a directory outside an app that lives below node_modules', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'node_modules', 'app');
    mkdirSync(root, { recursive: true });
    const directory = migrations(base, 'node_modules', 'other', 'migrations');
    expect(() => migrationDirectories(app(root, mod('other', directory)))).toThrow(/D20.*"other"/s);
  });

  it('gives a missing directory of an app below node_modules D14, not D20', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'node_modules', 'app');
    mkdirSync(root, { recursive: true });
    expect(() => migrationFiles(app(root, mod('x', 'modules/x/migrations')))).toThrow(/D14/);
  });

  it('refuses a helper folder that is a symlink into node_modules', () => {
    const root = tempDir('marmeon-files-');
    migrations(root, 'node_modules', '@acme', 'perm', 'helpers');
    const directory = migrations(root, 'modules', 'x', 'migrations');
    symlinkSync(join(root, 'node_modules', '@acme', 'perm', 'helpers'), join(directory, 'helpers'));
    expect(() => migrationFiles(app(root, mod('x', directory)))).toThrow(/D20.*@acme\/perm/s);
  });

  it('gives a dead symlink D14', () => {
    const root = tempDir('marmeon-files-');
    const directory = migrations(root, 'modules', 'x', 'migrations');
    symlinkSync(join(root, 'node_modules', 'gone', MIGRATION.replace('things', 'other')), join(directory, MIGRATION.replace('things', 'other')));
    expect(() => migrationFiles(app(root, mod('x', directory)))).toThrow(/D14.*symlink to a file that does not exist/s);
  });

  it('allows an app that itself lives below node_modules', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'node_modules', 'app');
    const directory = migrations(root, 'modules', 'x', 'migrations');
    expect(migrationDirectories(app(root, mod('x', directory)))).toHaveLength(1);
  });

  it('allows node_modules_old', () => {
    const root = tempDir('marmeon-files-');
    const directory = migrations(root, 'node_modules_old', 'perm', 'migrations');
    expect(migrationDirectories(app(root, mod('perm', directory)))).toHaveLength(1);
  });

  it('leaves a directory that does not exist to D14', () => {
    const root = tempDir('marmeon-files-');
    expect(() => migrationFiles(app(root, mod('x', 'modules/x/migrations')))).toThrow(/D14/);
  });
});
