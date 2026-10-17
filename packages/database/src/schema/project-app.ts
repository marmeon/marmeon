import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Application } from '@marmeon/core';
import { migrationFiles } from '../migrations/files.ts';
import { PROJECTION_FILE, UNWRITABLE, writeProjection } from './projection-file.ts';
import { projectMigrations } from './projection.ts';

/**
 * What `marmeon build` runs: the projection of the app's migrations, always computed from their plans (never taken from
 * `.marmeon/schema.json`, which a deploy may have left stale or altered) and written over the file. A migration that cannot be projected
 * (a table created twice, a change of a table raw SQL made) throws here, before the deploy, and so does a file that cannot be written for
 * a reason other than a read-only directory; `written` is false in that case, and `stale` says that an earlier file remains there for a start to read.
 */
export async function projectApp(app: Pick<Application, 'root' | 'modules'>): Promise<{ path: string; migrations: number; tables: number; written: boolean; stale: boolean }> {
  const files = migrationFiles(app);
  const projection = await projectMigrations(files);
  let written = true;
  try {
    writeProjection(app.root, projection, files);
  } catch (error) {
    if (!UNWRITABLE.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    written = false;
  }
  return { path: PROJECTION_FILE, migrations: projection.migrations.length, tables: projection.tables.size, written, stale: !written && existsSync(join(app.root, PROJECTION_FILE)) };
}
