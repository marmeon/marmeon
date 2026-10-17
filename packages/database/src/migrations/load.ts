import { hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { withCode } from '@marmeon/core/internal';
import type { Migration } from './migration.ts';

/** Where a migration file is, and whose it is. */
export interface MigrationSource {
  /** File name without extension. */
  readonly name: string;
  readonly module: string;
  readonly path: string;
  /** The SHA-256 of the bytes the caller read the file as, when it has them already: the plan is then the one of exactly these bytes. */
  readonly sha256?: string;
}

/** How often an import of a path at a hash was spent: that module may hold another version of the file than the hash says. */
const spent = new Map<string, number>();

/**
 * The module of `path` imported as `sha256` is not trusted any more (the file changed while it was read): the next import of that
 * hash evaluates the file again, under a URL no module has.
 */
export function spendImport(path: string, sha256: string): void {
  const key = `${path}\0${sha256}`;
  spent.set(key, (spent.get(key) ?? 0) + 1);
}

/**
 * Imports a migration file and checks that it exports a migration. Imported by its content, not only its path: Node keeps a module
 * for the life of the process, so a file edited while the development server runs would otherwise give its old plan.
 */
export async function loadMigration(file: MigrationSource): Promise<Migration> {
  const sha256 = file.sha256 ?? hash('sha256', readFileSync(file.path), 'hex');
  const again = spent.get(`${file.path}\0${sha256}`);
  const module = (await import(`${pathToFileURL(file.path).href}?sha256=${sha256}${again ? `&n=${again}` : ''}`)) as { default?: Partial<Migration> };
  if (typeof module.default?.up !== 'function') {
    throw new Error(withCode('D14', `Migration ${file.name} (module "${file.module}") must \`export default defineMigration({ up, down })\`.`));
  }
  return module.default as Migration;
}
