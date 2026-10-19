import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { byCodePoint } from '../introspection.ts';

/** `2026_10_01_120000_create_users_table.ts` — the timestamp orders migrations across all modules. */
const FILE = /^\d{4}_\d\d_\d\d_\d{6}_[a-z0-9_]+\.(ts|js|mts|mjs)$/;

export interface MigrationFile {
  /** File name without extension — unique across the app. */
  readonly name: string;
  readonly module: string;
  readonly path: string;
}

/**
 * The real path of `path`. A path that is not there is resolved through its nearest ancestor that is; a symlink that leads nowhere
 * is an error (D14), not a path to fall back on.
 */
function real(path: string): string {
  const resolved = resolve(path);
  if (lstatSync(resolved, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(resolved);
    return parent === resolved ? resolved : join(real(parent), basename(resolved));
  }
  try {
    return realpathSync.native(resolved);
  } catch {
    throw new Error(withCode('D14', `${resolved} is a symlink to a file that does not exist.`));
  }
}

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * The package a migrations directory belongs to when its real path runs through `node_modules`, `undefined` otherwise. Inside the
 * app root only the segments below it count, so an app that itself sits under a `node_modules` still runs.
 */
export function packageOfDirectory(directory: string, root: string): string | undefined {
  const path = real(directory);
  const inside = relative(real(root), path);
  if (inside === '') return undefined;
  const counted = inside !== '..' && !inside.startsWith('..\\') && !inside.startsWith('../') && !isAbsolute(inside) ? inside : path;
  const segments = counted.split(/[\\/]/);
  const at = segments.findLastIndex((segment) => segment.toLowerCase() === 'node_modules');
  if (at < 0) return undefined;
  const [first, second] = segments.slice(at + 1);
  if (!first) return undefined;
  return first.startsWith('@') && second ? `${first}/${second}` : first;
}

/** D20: the migrations of a module lie in a package in `node_modules`, by their real path. */
function refuse(module: string, pkg: string, path: string): Error {
  return new Error(
    withCode(
      'D20',
      `Module ${JSON.stringify(module)} reads its migrations from ${JSON.stringify(pkg)} in node_modules (real path ${path}): an update of the package could change a migration your database has run, and nothing would show in your app's history. Move its migration files, with the same names, into a module of your app and point \`migrations\` at them — see docs/migrations.md#migrations-from-a-package.`,
    ),
  );
}

/** The migrations directory of every module that has one, as its real path. A directory inside `node_modules` is refused (D20). */
export function migrationDirectories(app: Pick<Application, 'root' | 'modules'>): { module: string; directory: string }[] {
  return app.modules.flatMap((module) => {
    if (!module.migrations) return [];
    const directory = real(module.migrations instanceof URL ? fileURLToPath(module.migrations) : resolve(app.root, module.migrations));
    const pkg = packageOfDirectory(directory, app.root);
    if (pkg !== undefined) throw refuse(module.name, pkg, directory);
    return [{ module: module.name, directory }];
  });
}

/** Every migration file of every module of the app, in the order they run. */
export function migrationFiles(app: Pick<Application, 'root' | 'modules'>): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const { module, directory } of migrationDirectories(app)) {
    if (!existsSync(directory)) throw new Error(withCode('D14', `The migrations directory of module "${module}" does not exist: ${directory}`));
    for (const entry of readdirSync(directory)) {
      // A symlink to a package in node_modules is refused whatever it is, a helper or a folder included: a migration may import it.
      const link = join(directory, entry);
      if (lstatSync(link).isSymbolicLink()) {
        const target = realOrUndefined(link);
        const linked = target === undefined ? undefined : packageOfDirectory(target, app.root);
        if (linked !== undefined) throw refuse(module, linked, target!);
      }
      if (entry.endsWith('.d.ts') || /\.test\./.test(entry)) continue;
      if (!FILE.test(entry)) {
        if (/\.(ts|js|mts|mjs)$/.test(entry)) {
          throw new Error(withCode('D14', `Migration file name "${entry}" (module "${module}") must look like 2026_10_01_120000_create_users_table.ts.`));
        }
        continue;
      }
      // A file can be a symlink out of the directory; the real path is checked and is the one that gets imported.
      const path = real(join(directory, entry));
      const pkg = packageOfDirectory(path, app.root);
      if (pkg !== undefined) throw refuse(module, pkg, path);
      files.push({ name: basename(entry, extname(entry)), module, path });
    }
  }
  files.sort((a, b) => byCodePoint(a.name, b.name));
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.name === files[i - 1]!.name) {
      throw new Error(withCode('D15', `Two migrations are named "${files[i]!.name}" (modules "${files[i - 1]!.module}" and "${files[i]!.module}").`));
    }
  }
  return files;
}
