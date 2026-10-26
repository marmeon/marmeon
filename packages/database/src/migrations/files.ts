import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application } from '@marmeon/core';
import { printable, withCode } from '@marmeon/core/internal';
import { byCodePoint } from '../introspection.ts';
import { workspaceRoot } from '../workspace.ts';

/** `2026_10_01_120000_create_users_table.ts` — the timestamp orders migrations across all modules. */
const FILE = /^\d{4}_\d\d_\d\d_\d{6}_[a-z0-9_]+\.(ts|js|mts|mjs)$/;

/** A migration file of a module. */
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

/** What `refusedSource` found wrong with a path (D20). `pkg` is the package it belongs to, when that shows. */
export type RefusedSource = { kind: 'node_modules'; pkg: string | undefined } | { kind: 'outside'; pkg: string | undefined };

/** Whether `inside`, a relative path, stays below its base. */
function below(inside: string): boolean {
  return inside !== '..' && !inside.startsWith('..\\') && !inside.startsWith('../') && !isAbsolute(inside);
}

/** The `name` of the nearest `package.json` above `path`, made printable. */
function packageAbove(path: string): string | undefined {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      const { name } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (typeof name === 'string') return printable(name);
    } catch {
      // none here, or none that parses: look further up
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Why the real path of `path` may not hold migrations, `undefined` when it may: it must lie in the app root or in the workspace
 * root (`workspaceRoot`), and below that base no segment may be `node_modules`. Inside a base only the segments below it count, so
 * an app that itself sits under a `node_modules` still runs.
 */
export function refusedSource(path: string, root: string, workspace: string): RefusedSource | undefined {
  const target = real(path);
  let counted: string | undefined;
  for (const base of [real(root), workspace]) {
    const inside = relative(base, target);
    if (below(inside)) {
      counted = inside;
      break;
    }
  }
  if (counted === undefined) return { kind: 'outside', pkg: packageAbove(target) };
  if (counted === '') return undefined;
  const segments = counted.split(/[\\/]/);
  const at = segments.findLastIndex((segment) => segment.toLowerCase() === 'node_modules');
  if (at < 0) return undefined;
  const [first, second] = segments.slice(at + 1);
  return { kind: 'node_modules', pkg: first === undefined ? undefined : first.startsWith('@') && second ? `${first}/${second}` : first };
}

/** D20: the migrations of a module lie in `node_modules`, or outside the app and its workspace, by their real path. */
function refuse(module: string, why: RefusedSource, path: string): Error {
  const advice = `Move its migration files, with the same names, into a module of your app and point \`migrations\` at them — see docs/migrations.md#migrations-from-a-package.`;
  const pkg = why.pkg === undefined ? '' : JSON.stringify(why.pkg);
  if (why.kind === 'outside') {
    return new Error(
      withCode(
        'D20',
        `Module ${JSON.stringify(module)} reads its migrations from outside the app and its workspace (real path ${path}${pkg && `, package ${pkg}`}): nothing in your repository shows when they change, and a migration your database has run could change with them. ${advice}`,
      ),
    );
  }
  return new Error(
    withCode(
      'D20',
      `Module ${JSON.stringify(module)} reads its migrations from ${pkg ? `${pkg} in ` : 'a directory in '}node_modules (real path ${path}): an update of the package could change a migration your database has run, and nothing would show in your app's history. ${advice}`,
    ),
  );
}

/** The most entries below the migrations directory of a module that `walk` looks at. */
const MAX_ENTRIES = 2000;

/**
 * Checks every entry below `directory`, to any depth: a migration may import a helper from a folder next to it, and a symlink there
 * is as good a way to `node_modules` as one at the top. A symlink counts with its real target, and a directory it leads to is
 * entered. A symlink that leads nowhere is skipped here, nobody can import it.
 */
function walk(module: string, directory: string, root: string, workspace: string): void {
  const visited = new Set<string>();
  let entries = 0;
  const enter = (dir: string): void => {
    visited.add(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++entries > MAX_ENTRIES) {
        throw new Error(withCode('D14', `More than ${MAX_ENTRIES} entries below the migrations directory of module "${module}": ${directory}`));
      }
      const path = join(dir, entry.name);
      const target = entry.isSymbolicLink() ? realOrUndefined(path) : path;
      if (target === undefined) continue;
      const why = refusedSource(target, root, workspace);
      if (why !== undefined) throw refuse(module, why, real(target));
      if (!lstatSync(target).isDirectory()) continue;
      const inner = real(target);
      if (!visited.has(inner)) enter(inner);
    }
  };
  enter(real(directory));
}

/** The migrations directory of every module that has one, as its real path. One in `node_modules` or outside the app and its workspace is refused (D20). */
export function migrationDirectories(app: Pick<Application, 'root' | 'modules'>): { module: string; directory: string }[] {
  const workspace = workspaceRoot(app.root);
  return app.modules.flatMap((module) => {
    if (!module.migrations) return [];
    const directory = real(module.migrations instanceof URL ? fileURLToPath(module.migrations) : resolve(app.root, module.migrations));
    const why = refusedSource(directory, app.root, workspace);
    if (why !== undefined) throw refuse(module.name, why, directory);
    return [{ module: module.name, directory }];
  });
}

/** Every migration file of every module of the app, in the order they run. */
export function migrationFiles(app: Pick<Application, 'root' | 'modules'>): MigrationFile[] {
  const files: MigrationFile[] = [];
  const workspace = workspaceRoot(app.root);
  for (const { module, directory } of migrationDirectories(app)) {
    if (!existsSync(directory)) throw new Error(withCode('D14', `The migrations directory of module "${module}" does not exist: ${directory}`));
    walk(module, directory, app.root, workspace);
    for (const entry of readdirSync(directory)) {
      if (entry.endsWith('.d.ts') || /\.test\./.test(entry)) continue;
      if (!FILE.test(entry)) {
        if (/\.(ts|js|mts|mjs)$/.test(entry)) {
          throw new Error(withCode('D14', `Migration file name "${entry}" (module "${module}") must look like 2026_10_01_120000_create_users_table.ts.`));
        }
        continue;
      }
      // A file can be a symlink out of the directory; the real path is checked and is the one that gets imported.
      const path = real(join(directory, entry));
      const why = refusedSource(path, app.root, workspace);
      if (why !== undefined) throw refuse(module, why, path);
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
