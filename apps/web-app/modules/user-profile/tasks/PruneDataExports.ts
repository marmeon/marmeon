import { Clock, Logger } from '@marmeon/core';
import { Storage } from '@marmeon/storage';

/** How long an export stays on the private disk: its signed URL works five minutes (ExportMyDataController) — then some slack. */
export const EXPORT_KEEP_MINUTES = 15;

/**
 * "Download my data" leaves a JSON file on the private disk (`exports/user-<id>.json`) — the user's account and links. It
 * stays only as long as its download link works (and a little longer): this task deletes older ones (the scheduler runs it
 * every ten minutes, `s.call(PruneDataExports)`).
 */
export class PruneDataExports {
  readonly #storage: Storage;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(storage: Storage, clock: Clock, logger: Logger) {
    this.#storage = storage;
    this.#clock = clock;
    this.#logger = logger;
  }

  async handle(): Promise<number> {
    const disk = this.#storage.disk('local');
    const before = this.#clock.now() - EXPORT_KEEP_MINUTES * 60_000;
    let deleted = 0;
    for (const key of await disk.list('exports')) {
      if ((await disk.lastModified(key)).getTime() <= before && (await disk.delete(key))) deleted++;
    }
    if (deleted > 0) this.#logger.info('Deleted old data exports', { deleted });
    return deleted;
  }
}
