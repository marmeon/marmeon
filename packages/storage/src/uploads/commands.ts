import type { Resolver } from '@marmeon/core';
import { Application, Clock, CommandArgumentsError } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { UploadsConfig } from './config.ts';
import { TemporaryUploads } from './service.ts';

/** The migration `make:uploads-table` copies — a real file, so the tests run exactly what apps get. */
export const UPLOADS_MIGRATION = new URL('../../stubs/migrations/0001_01_01_000000_create_temporary_uploads_table.ts', import.meta.url);

/** The connection `temporary_uploads` belongs on — for the migration `make:uploads-table` writes: `UPLOADS_CONNECTION`. */
export function uploadsTableConnection(container: Resolver): string {
  return container.make(UploadsConfig).connection;
}

/** `marmeon make:uploads-table [--module=system]`: the migration of `temporary_uploads` into an app module. */
export class MakeUploadsTableCommand {
  static command = 'make:uploads-table';
  static description = 'Create the migration for temporary uploads (temporary_uploads)';
  static usage = '[--module=system]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle(input: CommandInput): Promise<number> {
    const [{ publishOwnMigrations }, { StorageServiceProvider }] = await Promise.all([import('@marmeon/database/internal'), import('../index.ts')]);
    return publishOwnMigrations(input, new URL('../../', import.meta.url), StorageServiceProvider, this.#app.providers);
  }
}

const HOUR = 3_600_000;

/**
 * `marmeon uploads:prune [--hours=24] [--force]`: deletes unused uploads at once when they expire (after `UPLOADS_LIFETIME_MINUTES`: the open
 * ones count against the limits of `UPLOADS_MAX_OPEN`), and every other upload — used ones — once it was made more than `--hours`
 * ago; the rows first (one statement), then their files. `--hours` below `UPLOADS_LIFETIME_MINUTES` would delete
 * uploads whose token still works (a form still open): refused unless `--force`. For the scheduler:
 * `s.command('uploads:prune').hourly().withoutOverlapping().onOneServer()` (with a local uploads disk on several servers: without
 * `onOneServer`, on each).
 */
export class PruneUploadsCommand {
  static command = 'uploads:prune';
  static description = 'Delete unused expired temporary uploads at once and the rest after a day (rows, then files)';
  static usage = '[--hours=24] [--force]';
  static options = { hours: { type: 'string' }, force: { type: 'boolean' } } as const;

  readonly #uploads: TemporaryUploads;
  readonly #clock: Clock;
  readonly #config: UploadsConfig;

  /** @internal The container builds the command. */
  constructor(uploads: TemporaryUploads, clock: Clock, config: UploadsConfig) {
    this.#uploads = uploads;
    this.#clock = clock;
    this.#config = config;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const hours = options.hours === undefined ? 24 : Number(options.hours);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new CommandArgumentsError(`--hours must be a number ≥ 0 (uploads made longer ago than that are deleted), not ${String(options.hours)}.`);
    }
    const lifetime = this.#config.lifetimeMinutes; // minutes
    if (hours * 60 < lifetime && options.force !== true) {
      output.error(
        `--hours=${String(options.hours)} would delete uploads whose token still works: a token works for ${lifetime} minutes (UPLOADS_LIFETIME_MINUTES), ` +
          `so --hours must be at least ${formatHours(lifetime / 60)} — or pass --force to delete them anyway (a form still open loses its files).`,
      );
      return 1;
    }
    const pruned = await this.#uploads.prune(this.#clock.now() - hours * HOUR);
    output.success(`Pruned ${pruned} temporary ${pruned === 1 ? 'upload' : 'uploads'}.`);
    return 0;
  }
}

/** `2`, `0.5`, `1.25` — hours as a short number. */
function formatHours(hours: number): string {
  return String(Math.round(hours * 100) / 100);
}
