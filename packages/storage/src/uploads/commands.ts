import { readFileSync } from 'node:fs';
import type { Resolver } from '@marmeon/core';
import { Clock } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { UploadsConfig } from './config.ts';
import { TemporaryUploads } from './service.ts';

/** The migration `make:uploads-table` copies — a real file, so the tests run exactly what apps get. */
export const UPLOADS_MIGRATION = new URL('../../stubs/migrations/create_temporary_uploads_table.ts', import.meta.url);

/** The connection `temporary_uploads` belongs on — for the migration `make:uploads-table` writes: `UPLOADS_CONNECTION`. */
export function uploadsTableConnection(container: Resolver): string {
  return container.make(UploadsConfig).connection;
}

/** `marmeon make:uploads-table [--module=system]`: the migration of `temporary_uploads` into an app module (E96). */
export class MakeUploadsTableCommand {
  static command = 'make:uploads-table';
  static description = 'Create the migration for temporary uploads (temporary_uploads)';
  static usage = '[--module=system]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  async handle(input: CommandInput): Promise<number> {
    const { publishMigration } = await import('@marmeon/database');
    return publishMigration(input, { name: 'create_temporary_uploads_table', table: 'temporary_uploads', contents: readFileSync(UPLOADS_MIGRATION, 'utf8') });
  }
}

const HOUR = 3_600_000;

/**
 * `marmeon uploads:prune [--hours=24]`: deletes temporary uploads made more than `--hours` ago — used, expired or never
 * sent — the rows first (one statement), then their files. A token never works longer than a day (`UPLOADS_LIFETIME`), so
 * nothing usable goes. For the scheduler: `s.command('uploads:prune').hourly().withoutOverlapping().onOneServer()` (with a
 * local uploads disk on several servers: without `onOneServer`, on each).
 */
export class PruneUploadsCommand {
  static command = 'uploads:prune';
  static description = 'Delete temporary uploads older than a day (rows, then files)';
  static usage = '[--hours=24]';
  static options = { hours: { type: 'string' } } as const;

  readonly #uploads: TemporaryUploads;
  readonly #clock: Clock;

  constructor(uploads: TemporaryUploads, clock: Clock) {
    this.#uploads = uploads;
    this.#clock = clock;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const hours = options.hours === undefined ? 24 : Number(options.hours);
    if (!Number.isFinite(hours) || hours < 0) {
      output.error(`--hours must be a number ≥ 0 (uploads made longer ago than that are deleted), not ${String(options.hours)}.`);
      return 1;
    }
    const pruned = await this.#uploads.prune(this.#clock.now() - hours * HOUR);
    output.success(`Pruned ${pruned} temporary ${pruned === 1 ? 'upload' : 'uploads'}.`);
    return 0;
  }
}
