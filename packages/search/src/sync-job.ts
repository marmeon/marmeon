import type { StandardSchemaV1 } from '@marmeon/core';
import type { JobContext } from '@marmeon/queue';
import * as v from 'valibot';
import type { SearchDriver } from './driver.ts';
import type { SearchIndexes } from './registry.ts';
import { BATCH_SIZE, MAX_KEY_LENGTH, write, type IndexReader, type SyncPayload } from './search.ts';

const key = v.union([
  v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_KEY_LENGTH), v.check((text) => text.isWellFormed() && !text.includes('\u0000'), 'must be well-formed text without NUL')),
  v.pipe(v.number(), v.safeInteger()),
]);

/** @internal The validation behind `SyncSearchDocuments.schema`; format v1 of the payload, see `__fixtures__/formats/search-sync/`. */
export const syncPayloadSchema = v.strictObject({
  index: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{0,63}$/)),
  keys: v.pipe(v.array(key), v.minLength(1), v.maxLength(BATCH_SIZE)),
});

/**
 * The framework job behind `search.index()` and `search.remove()` on a driver that writes through the queue: reads the rows of its
 * keys through the index's `source()` when it runs and writes their documents or removes them, so of two jobs that run one after
 * the other the later one wins. Carries only keys, never text. A driver error retries the job. See `docs/full-text-search.md#keeping-the-index-current`.
 */
export class SyncSearchDocuments {
  static readonly job = 'marmeon.search.sync';
  static readonly schema: StandardSchemaV1<SyncPayload> = syncPayloadSchema;
  static readonly tries = 5;
  static readonly backoff = [10, 60, 300];
  static readonly timeout = 60;

  readonly #indexes: SearchIndexes;
  readonly #reader: IndexReader;
  readonly #driver: SearchDriver;

  constructor(indexes: SearchIndexes, reader: IndexReader, driver: SearchDriver) {
    this.#indexes = indexes;
    this.#reader = reader;
    this.#driver = driver;
  }

  async handle(payload: SyncPayload, job: JobContext): Promise<void> {
    const Index = this.#indexes.get(payload.index);
    if (Index === undefined) {
      // Retrying cannot help: the job fails for good and stays readable in the failed jobs, nothing is dropped silently.
      return job.fail(`No search index is named "${payload.index}" any more (it was renamed or removed), so the documents of this job were not synced.`);
    }
    const found = await this.#reader.read(Index, payload.keys, { tolerant: true });
    await write(this.#driver, this.#indexes.info(Index), found);
    // The rest of the batch is written, the broken rows are out of the index; the attempt still fails, so it shows in the failed jobs.
    if (found.failed.length > 0) {
      const [first] = found.failed;
      throw new Error(
        `${found.failed.length} of the keys of "${payload.index}" failed a check, and the index holds no document for them (keys ${found.failed.map((entry) => JSON.stringify(entry.key)).join(', ')}): ${first!.error instanceof Error ? first!.error.message : String(first!.error)}`,
        { cause: first!.error },
      );
    }
  }
}
