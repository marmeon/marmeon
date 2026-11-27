import type { SearchKey } from './driver.ts';

/**
 * Thrown at the start for a search setup that cannot work, such as a `SEARCH_DRIVER` nobody brought or a driver name a provider may
 * not use. Its message starts with the code `Q9`. See `docs/errors.md#server-error-codes`.
 */
export class SearchSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SearchSetupError';
  }
}

/** The largest `tsvector` Postgres builds, in bytes. */
const TSVECTOR_LIMIT = 1_048_575;

/**
 * @internal Thrown by the `database` driver on Postgres after it wrote every other document of the call and removed the old documents
 * of these keys: their text makes a `tsvector` over the limit of Postgres. `Search.index()` in a transaction of its own commits that
 * first; a rebuild reports the keys and goes on.
 */
export class DocumentsTooLongError extends Error {
  override name = 'DocumentsTooLongError';
  readonly keys: readonly SearchKey[];

  constructor(index: string, keys: readonly SearchKey[], cause: unknown) {
    const shown = keys.slice(0, 20).map((key) => JSON.stringify(key)).join(', ') + (keys.length > 20 ? ` and ${keys.length - 20} more` : '');
    super(
      `The ${keys.length === 1 ? 'document of the key' : 'documents of the keys'} ${shown} in the search index "${index}" ${keys.length === 1 ? 'is' : 'are'} too long for Postgres: ` +
        `the words of the text make a tsvector over its limit of ${TSVECTOR_LIMIT} bytes, so the index holds no document for ${keys.length === 1 ? 'it' : 'them'}. Return less text from toDocument() for ${keys.length === 1 ? 'that row' : 'those rows'}.`,
      { cause },
    );
    this.keys = keys;
  }
}
