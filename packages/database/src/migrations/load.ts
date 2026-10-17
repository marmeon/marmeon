import { pathToFileURL } from 'node:url';
import { withCode } from '@marmeon/core/internal';
import type { Migration } from './migration.ts';

/** Where a migration file is, and whose it is. */
export interface MigrationSource {
  /** File name without extension. */
  readonly name: string;
  readonly module: string;
  readonly path: string;
}

/** Imports a migration file and checks that it exports a migration. */
export async function loadMigration(file: MigrationSource): Promise<Migration> {
  const module = (await import(pathToFileURL(file.path).href)) as { default?: Partial<Migration> };
  if (typeof module.default?.up !== 'function') {
    throw new Error(withCode('D14', `Migration ${file.name} (module "${file.module}") must \`export default defineMigration({ up, down })\`.`));
  }
  return module.default as Migration;
}
