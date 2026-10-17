import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Application } from '@marmeon/core';
import type { CommandInput } from './command.ts';
import { hasPackage } from './commands/schema-project.ts';

/**
 * Starts the watcher of `@marmeon/database` over the app's migration directories (`marmeon dev`; the CLI does not depend on the
 * package, so it is found in the app, and an app without it has nothing to watch). A failure is a warning, never fatal.
 * See docs/migrations.md#while-you-develop.
 */
export async function watchMigrations(app: Application, root: string, output: CommandInput['output']): Promise<{ close(): void } | undefined> {
  if (!app.modules.some((module) => (module as { migrations?: unknown }).migrations) || !hasPackage(root)) return undefined;
  try {
    const path = createRequire(join(root, 'package.json')).resolve('@marmeon/database/internal');
    const internals = (await import(pathToFileURL(path).href)) as { watchMigrations(app: Application, warn: (message: string) => void): { close(): void } };
    return internals.watchMigrations(app, (message) => output.warn(message));
  } catch (error) {
    output.warn(`Could not watch the migrations: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
