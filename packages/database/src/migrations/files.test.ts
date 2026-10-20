import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { workspaceRoot } from '../workspace.ts';
import { migrationDirectories, migrationFiles, refusedSource } from './files.ts';

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

/** An app at `apps/app` in a workspace: the lockfile and the declaration lie in the base. */
function monorepo(): { base: string; root: string } {
  const base = tempDir('marmeon-files-');
  const root = join(base, 'apps', 'app');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(base, 'pnpm-lock.yaml'), '');
  writeFileSync(join(base, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  return { base, root };
}

describe('refusedSource', () => {
  const check = (path: string, root: string) => refusedSource(path, root, workspaceRoot(root));

  it('names the package below the last node_modules', () => {
    const root = tempDir('marmeon-files-');
    expect(check(migrations(root, 'node_modules', '@acme', 'perm', 'migrations'), root)).toEqual({ kind: 'node_modules', pkg: '@acme/perm' });
    expect(check(migrations(root, 'node_modules', 'perm', 'migrations'), root)).toEqual({ kind: 'node_modules', pkg: 'perm' });
    expect(check(migrations(root, 'node_modules', '.pnpm', '@acme+perm@1.0.0', 'node_modules', '@acme', 'perm', 'migrations'), root)).toEqual({
      kind: 'node_modules',
      pkg: '@acme/perm',
    });
  });

  it('ignores the segments of the app root and names that only start with node_modules', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'node_modules', 'app');
    mkdirSync(root, { recursive: true });
    expect(check(migrations(root, 'modules', 'x', 'migrations'), root)).toBeUndefined();
    expect(check(migrations(root, 'node_modules_old', 'perm', 'migrations'), root)).toBeUndefined();
  });

  it('matches the segment without regard to case', () => {
    const root = tempDir('marmeon-files-');
    expect(check(join(root, 'Node_Modules', 'perm', 'migrations'), root)).toEqual({ kind: 'node_modules', pkg: 'perm' });
  });

  it('names the package of a path outside the app from the nearest package.json', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'app');
    mkdirSync(root, { recursive: true });
    const directory = migrations(base, 'cache', '@acme', 'perm@1.0.0', 'migrations');
    writeFileSync(join(base, 'cache', '@acme', 'perm@1.0.0', 'package.json'), JSON.stringify({ name: '@acme/perm' }));
    expect(check(directory, root)).toEqual({ kind: 'outside', pkg: '@acme/perm' });
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
    const { base, root } = monorepo();
    mkdirSync(join(root, 'node_modules', '@acme'), { recursive: true });
    const workspace = migrations(base, 'packages', 'perm', 'migrations');
    symlinkSync(join(base, 'packages', 'perm'), join(root, 'node_modules', '@acme', 'perm'));
    const viaLink = join(root, 'node_modules', '@acme', 'perm', 'migrations');
    for (const path of [workspace, viaLink]) {
      expect(migrationFiles(app(root, mod('perm', path))).map((file) => file.module)).toEqual(['perm']);
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a workspace whose root is writable by everyone', () => {
    const { base, root } = monorepo();
    const workspace = migrations(base, 'packages', 'perm', 'migrations');
    chmodSync(base, 0o777);
    expect(() => migrationDirectories(app(root, mod('perm', workspace)))).toThrow(/D20.*outside the app and its workspace/s);
  });

  it('refuses a monorepo directory outside the app when nothing declares a workspace', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'apps', 'app');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(base, 'pnpm-lock.yaml'), '');
    const workspace = migrations(base, 'packages', 'perm', 'migrations');
    expect(() => migrationDirectories(app(root, mod('perm', workspace)))).toThrow(/D20.*outside the app and its workspace/s);
  });

  it('refuses a cache of a package manager outside the app, directly and through node_modules', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'app');
    mkdirSync(join(root, 'node_modules', '@acme'), { recursive: true });
    const cache = join(base, 'cache', '@acme', 'perm@1.0.0');
    const directory = migrations(cache, 'migrations');
    writeFileSync(join(cache, 'package.json'), JSON.stringify({ name: '@acme/perm' }));
    symlinkSync(cache, join(root, 'node_modules', '@acme', 'perm'));
    const viaLink = join(root, 'node_modules', '@acme', 'perm', 'migrations');
    for (const path of [directory, viaLink]) {
      expect(() => migrationDirectories(app(root, mod('perm', path)))).toThrow(/D20.*outside the app and its workspace.*"@acme\/perm"/s);
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
    expect(() => migrationDirectories(app(root, mod('perm', directory)))).toThrow(/D20.*outside the app and its workspace/s);
  });

  it('refuses a package hoisted to the root of a workspace', () => {
    const { base, root } = monorepo();
    const directory = migrations(base, 'node_modules', '@acme', 'perm', 'migrations');
    expect(() => migrationDirectories(app(root, mod('perm', directory)))).toThrow(/D20.*@acme\/perm.*in node_modules/s);
  });

  it('checks the whole path of a directory outside an app that lives below node_modules', () => {
    const base = tempDir('marmeon-files-');
    const root = join(base, 'node_modules', 'app');
    mkdirSync(root, { recursive: true });
    const directory = migrations(base, 'node_modules', 'other', 'migrations');
    expect(() => migrationDirectories(app(root, mod('other', directory)))).toThrow(/D20.*"other".*outside/s);
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

  describe('below the top level', () => {
    const helperIn = (root: string) => {
      const target = migrations(root, 'node_modules', '@acme', 'perm', 'helpers');
      const directory = migrations(root, 'modules', 'x', 'migrations');
      return { target, directory };
    };

    it('refuses a symlink in a helper folder that leads into node_modules', () => {
      const root = tempDir('marmeon-files-');
      const { target, directory } = helperIn(root);
      mkdirSync(join(directory, 'helpers', 'deeper'), { recursive: true });
      symlinkSync(join(target, MIGRATION), join(directory, 'helpers', 'link.ts'));
      expect(() => migrationFiles(app(root, mod('x', directory)))).toThrow(/D20.*@acme\/perm/s);
      rmSync(join(directory, 'helpers', 'link.ts'));
      symlinkSync(join(target, MIGRATION), join(directory, 'helpers', 'deeper', 'link.ts'));
      expect(() => migrationFiles(app(root, mod('x', directory)))).toThrow(/D20/);
    });

    it('refuses a folder that is a symlink out of the workspace', () => {
      const base = tempDir('marmeon-files-');
      const root = join(base, 'app');
      const outside = migrations(base, 'elsewhere');
      const directory = migrations(root, 'modules', 'x', 'migrations');
      mkdirSync(join(directory, 'helpers'), { recursive: true });
      symlinkSync(outside, join(directory, 'helpers', 'out'));
      expect(() => migrationFiles(app(root, mod('x', directory)))).toThrow(/D20.*outside the app and its workspace/s);
    });

    it('refuses a real node_modules folder in the migrations directory', () => {
      const root = tempDir('marmeon-files-');
      const directory = migrations(root, 'modules', 'x', 'migrations');
      mkdirSync(join(directory, 'node_modules'));
      writeFileSync(join(directory, 'node_modules', 'x.ts'), '');
      expect(() => migrationFiles(app(root, mod('x', directory)))).toThrow(/D20.*node_modules/s);
    });

    it('gives D14 for more than 2000 entries', () => {
      const root = tempDir('marmeon-files-');
      const directory = migrations(root, 'modules', 'x', 'migrations');
      mkdirSync(join(directory, 'helpers'));
      for (let i = 0; i < 2000; i++) writeFileSync(join(directory, 'helpers', `h${i}.ts`), '');
      expect(() => migrationFiles(app(root, mod('x', directory)))).toThrow(/D14.*2000 entries/s);
    });

    it('ends at a symlink cycle and skips a symlink that leads nowhere', () => {
      const root = tempDir('marmeon-files-');
      const directory = migrations(root, 'modules', 'x', 'migrations');
      mkdirSync(join(directory, 'helpers'));
      symlinkSync('..', join(directory, 'helpers', 'loop'));
      symlinkSync(join(root, 'gone'), join(directory, 'helpers', 'dead'));
      expect(migrationFiles(app(root, mod('x', directory))).map((file) => file.name)).toEqual([MIGRATION.replace('.ts', '')]);
    });
  });
});
