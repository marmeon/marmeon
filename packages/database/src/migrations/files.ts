import { existsSync, readdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
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

/** The migrations directory of every module that has one, as a path. */
export function migrationDirectories(app: Pick<Application, 'root' | 'modules'>): { module: string; directory: string }[] {
  return app.modules.flatMap((module) =>
    module.migrations ? [{ module: module.name, directory: module.migrations instanceof URL ? fileURLToPath(module.migrations) : resolve(app.root, module.migrations) }] : [],
  );
}

/** Every migration file of every module of the app, in the order they run. */
export function migrationFiles(app: Pick<Application, 'root' | 'modules'>): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const { module, directory } of migrationDirectories(app)) {
    if (!existsSync(directory)) throw new Error(withCode('D14', `The migrations directory of module "${module}" does not exist: ${directory}`));
    for (const entry of readdirSync(directory)) {
      if (entry.endsWith('.d.ts') || /\.test\./.test(entry)) continue;
      if (!FILE.test(entry)) {
        if (/\.(ts|js|mts|mjs)$/.test(entry)) {
          throw new Error(withCode('D14', `Migration file name "${entry}" (module "${module}") must look like 2026_10_01_120000_create_users_table.ts.`));
        }
        continue;
      }
      files.push({ name: basename(entry, extname(entry)), module, path: join(directory, entry) });
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
