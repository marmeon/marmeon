import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application } from '@marmeon/core';
import type { CommandInput } from '../command.ts';

/** What `@marmeon/database/internal` offers this command — found in the app, since the CLI does not depend on the package. */
interface DatabaseInternals {
  projectApp(app: Application): Promise<{ path: string; migrations: number; tables: number; written: boolean; stale: boolean }>;
}

/**
 * Computes the schema the app's migrations describe and keeps it in `.marmeon/schema.json` (`@marmeon/database`; an app without it
 * has nothing to do unless a module has migrations). `marmeon build` runs it, so a migration whose plan cannot be projected stops the build instead of the deploy.
 * See docs/deployment.md#building-and-starting.
 */
export class SchemaProjectCommand {
  static command = 'schema:project';
  static description = 'Write the schema the migrations describe to .marmeon/schema.json';
  static hidden = true;
  /** Registers the modules and boots nothing, like `route:types` — `marmeon build` runs it without secrets. */
  static boots = 'build' as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle({ output, root }: CommandInput): Promise<number> {
    let path: string;
    try {
      // Only the app's node_modules chain counts: `require.resolve` also searches NODE_PATH, which pnpm's shims point at the store.
      if (!hasPackage(root)) throw new Error('not installed');
      path = createRequire(join(root, 'package.json')).resolve('@marmeon/database/internal');
    } catch {
      // Without the package nothing reads a schema, unless a module brings migrations: those must be projected.
      if (!this.#app.modules.some((module) => (module as { migrations?: unknown }).migrations)) return 0;
      output.error('A module has migrations, but @marmeon/database is not installed in this app, so they cannot be projected: add @marmeon/database as a dependency of the app (pnpm add @marmeon/database).');
      return 1;
    }
    const { projectApp } = (await import(pathToFileURL(path).href)) as DatabaseInternals;
    try {
      const projected = await projectApp(this.#app);
      if (projected.stale) {
        output.error(`${projected.path} cannot be written here, and an earlier one remains that a start would read: remove ${projected.path} or make .marmeon writable.`);
        return 1;
      }
      if (projected.written) output.success(`Projected ${projected.tables} table${projected.tables === 1 ? '' : 's'} of ${projected.migrations} migration${projected.migrations === 1 ? '' : 's'} → ${projected.path}`);
      else output.warn(`Projected ${projected.tables} tables of ${projected.migrations} migrations, but ${projected.path} cannot be written here (and none exists): a start computes them itself.`);
      return 0;
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
}

function hasPackage(root: string): boolean {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', '@marmeon', 'database', 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
}
