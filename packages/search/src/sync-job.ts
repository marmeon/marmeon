import { SystemClock, type Clock, type StandardSchemaV1 } from '@marmeon/core';
import type { JobContext } from '@marmeon/queue';
import * as v from 'valibot';
import type { SearchDriver } from './driver.ts';
import type { SearchIndexes } from './registry.ts';
import { BATCH_SIZE, keyId, MAX_KEY_LENGTH, write, type IndexReader, type ReadResult, type SyncPayload } from './search.ts';

const key = v.union([
  v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_KEY_LENGTH), v.check((text) => text.isWellFormed() && !text.includes('\u0000'), 'must be well-formed text without NUL')),
  v.pipe(v.number(), v.safeInteger()),
]);

/** @internal The validation behind `SyncSearchDocuments.schema`; format v1 of the payload, see `__fixtures__/formats/search-sync/`. */
export const syncPayloadSchema = v.strictObject({
  index: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{0,63}$/)),
  keys: v.pipe(v.array(key), v.minLength(1), v.maxLength(BATCH_SIZE)),
});

/** The most times one attempt writes its rows while they keep changing. */
export const MAX_WRITES = 3;

/** Whether two reads of the same keys found the same documents and the same removals. */
function sameRead(first: ReadResult, second: ReadResult): boolean {
  // Filters keep the order toDocument() gave them, so they are compared sorted; fields are already in declared order.
  const shape = (found: ReadResult): string =>
    JSON.stringify([
      found.documents
        .map((document) => [keyId(document.key), { ...document, filters: Object.fromEntries(Object.entries(document.filters).sort(([a], [b]) => (a < b ? -1 : 1))) }] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
      found.removed.map(keyId).sort(),
    ]);
  return shape(first) === shape(second);
}

/**
 * The framework job behind `search.index()` and `search.remove()` on a driver that writes through the queue: reads the rows of its
 * keys through the index's `source()` when it runs and writes their documents or removes them, then reads them again and writes
 * again while they changed (at most three writes), so the index ends with the rows' state, also when two jobs overlap. Carries only keys, never text. A driver error retries the job. See `docs/full-text-search.md#keeping-the-index-current`.
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
  readonly #clock: Clock;

  constructor(indexes: SearchIndexes, reader: IndexReader, driver: SearchDriver, clock: Clock = new SystemClock()) {
    this.#indexes = indexes;
    this.#reader = reader;
    this.#driver = driver;
    this.#clock = clock;
  }

  async handle(payload: SyncPayload, job: JobContext): Promise<void> {
    const Index = this.#indexes.get(payload.index);
    if (Index === undefined) {
      // Retrying cannot help: the job fails for good and stays readable in the failed jobs, nothing is dropped silently.
      return job.fail(`No search index is named "${payload.index}" any more (it was renamed or removed), so the documents of this job were not synced.`);
    }
    const info = this.#indexes.info(Index);
    const ranOut = () => new Error(`The job for "${payload.index}" ran out of time after writing its rows; it tries again.`);
    const started = this.#clock.now();
    let roundStarted = started;
    let found = await this.#reader.read(Index, payload.keys, { tolerant: true });
    for (let round = 1; ; round++) {
      await write(this.#driver, info, found);
      // A job past its timeout stops here rather than read and write again; the worker would end it soon after.
      if (job.signal.aborted) throw ranOut();
      const now = this.#clock.now();
      const lasted = now - roundStarted;
      roundStarted = now;
      // Another job of the same rows may have read an older state and written it after this one: reading again after the write, and
      // writing again while the rows changed, leaves the state of the last write in the index.
      const again = await this.#reader.read(Index, payload.keys, { tolerant: true });
      if (sameRead(found, again)) break;
      if (round === MAX_WRITES) {
        throw new Error(`The rows of "${payload.index}" changed each of the ${MAX_WRITES} times this job wrote them; the attempt fails, and the job tries again.`);
      }
      // Another round that would outlast the timeout is not started: a worker ends a job that runs well past it, and every job it holds.
      if (now - started + lasted > SyncSearchDocuments.timeout * 1000) throw ranOut();
      found = again;
    }
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
