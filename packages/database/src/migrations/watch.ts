import { existsSync, watch, type FSWatcher } from 'node:fs';
import { Application, environment } from '@marmeon/core';
import { Connections } from '../connections.ts';
import { migrationDirectories } from './files.ts';

/** Quiet time after the last change before the schema is read again: an editor saves a file in several steps. */
const SETTLE_MS = 100;

/**
 * `marmeon dev` only: when a migration file is added, changed or removed in any module's migrations directory, every managed connection
 * reads the migration files again and compares them with the database — the next query is refused until `marmeon migrate` ran if the
 * database lacks a migration, and answered once it has (a `migrate` in another terminal is noticed within a second). Does nothing in
 * any other environment. See docs/migrations.md#while-you-develop.
 */
export function watchMigrations(app: Application, warn: (message: string) => void = (message) => process.emitWarning(message)): { close(): void } {
  const watchers: FSWatcher[] = [];
  if (!environment.isDevelopment()) return { close() {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const connections = app.container.make(Connections);
        for (const name of connections.used()) {
          const metadata = connections.metadata(name);
          if (metadata.managed) metadata.reload();
        }
      } catch (error) {
        warn(`Could not read the migrations again: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, SETTLE_MS);
    timer.unref();
  };
  for (const { directory } of migrationDirectories(app)) {
    // A directory that is not there yet is reported by the first query, as in production; one created while the server runs is
    // watched after the next restart.
    if (!existsSync(directory)) continue;
    const watcher = watch(directory, { persistent: false }, reload);
    // The directory was removed or cannot be watched any more: the watcher ends, the server runs on.
    watcher.on('error', () => watcher.close());
    watchers.push(watcher);
  }
  return {
    close() {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
