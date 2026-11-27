import { createHash } from 'node:crypto';
import { err, ok, type Logger, type Result } from '@marmeon/core';
import type { DriverHit, DriverPage, DriverQuery, SearchDriver, SearchFailure, SearchKey, StoredDocument } from '../../driver.ts';
import type { IndexInfo } from '../../registry.ts';
import { excerptSegments, MARK_END, MARK_START, meilisearchFilter, meilisearchFilterValue, type ExcerptSegment } from '../../terms.ts';
import { MeilisearchError, SearchSyncError, type MeilisearchClient } from './client.ts';

/** How many words of context an excerpt keeps. */
const CROP_LENGTH = 24;
/** The most hits Meilisearch counts and pages through, as `Search` reaches. */
const MAX_TOTAL_HITS = 1000;
const WEIGHT_ORDER = ['A', 'B', 'C', 'D'] as const;
// An index uid Meilisearch accepts and a path segment cannot misread.
const INDEX_UID = /^[A-Za-z0-9_-]{1,128}$/;
// A canonical locale (`pt-BR`); `Search` hands over no other form.
const LOCALE = /^[A-Za-z0-9-]{1,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The Meilisearch id of a document: base64url of the SHA-256 of the key as JSON. Any key becomes a valid id of 43 characters (an id
 * holds at most 511 bytes, which a long non-ASCII key would pass), `42` and `"42"` stay two documents, and no key reaches a path.
 * @internal
 */
export function documentId(key: SearchKey): string {
  return createHash('sha256').update(JSON.stringify(key), 'utf8').digest('base64url');
}

/** The fields of an index in the order of their weights, `A` first, and in declaration order within one weight. */
function fieldsByWeight(index: IndexInfo): string[] {
  return WEIGHT_ORDER.flatMap((weight) => index.fields.filter((field) => field.weight === weight).map((field) => `s_${field.name}`));
}

function uid(name: string): string {
  if (typeof name !== 'string' || !INDEX_UID.test(name)) throw new TypeError(`${JSON.stringify(String(name)).slice(0, 80)} is not a Meilisearch index name this driver uses.`);
  return name;
}

/**
 * A document as Meilisearch stores it: `id`, the key, the locale (`null` for none), each field as `s_<name>` and each filter as
 * `f_<name>` holding the hash of its value, so a filter compares exactly (see `meilisearchFilterValue`).
 * @internal
 */
export function meilisearchDocument(document: StoredDocument): Record<string, unknown> {
  const stored: Record<string, unknown> = { id: documentId(document.key), key: document.key, locale: document.locale };
  for (const [name, text] of Object.entries(document.fields)) stored[`s_${name}`] = text;
  for (const [name, value] of Object.entries(document.filters)) stored[`f_${name}`] = meilisearchFilterValue(value, name);
  return stored;
}

/**
 * The settings of an index: the fields searched in the order of their weights, `locale` and the filters filterable, only the key and
 * the fields displayed (the fields only for excerpts; a search retrieves the key alone), and at most 1000 hits counted.
 * @internal
 */
export function meilisearchSettings(index: IndexInfo): Record<string, unknown> {
  const fields = fieldsByWeight(index);
  return {
    searchableAttributes: fields,
    filterableAttributes: ['locale', ...index.filters.map((name) => `f_${name}`)],
    displayedAttributes: ['key', ...fields],
    pagination: { maxTotalHits: MAX_TOTAL_HITS },
  };
}

/** The `filter` of one search: the filters through `meilisearchFilter`, and with a locale the documents of it and those without one. */
function filterOf(request: DriverQuery): string | undefined {
  const parts: string[] = [];
  const filters = meilisearchFilter(request.filters);
  if (filters !== '') parts.push(filters);
  if (request.locale !== undefined) {
    if (!LOCALE.test(request.locale)) throw new TypeError('The search locale is not in its canonical form.');
    parts.push(`(locale = "${request.locale}" OR locale IS NULL)`);
  }
  return parts.length === 0 ? undefined : parts.join(' AND ');
}

/**
 * The body of `POST /multi-search`: one federated search over every index, paged as `Search` asks. The query is the tokens alone, so
 * no quote or `-` the user typed is Meilisearch syntax; every token must match (`matchingStrategy: 'all'`), and Meilisearch always
 * matches the last one as a prefix too.
 * @internal
 */
export function multiSearchBody(request: DriverQuery): Record<string, unknown> {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset % request.limit !== 0) {
    throw new TypeError('The search driver takes an offset that is a whole multiple of the limit, as Search computes them.');
  }
  const filter = filterOf(request);
  const q = request.tokens.join(' ');
  return {
    federation: { page: request.offset / request.limit + 1, hitsPerPage: request.limit },
    queries: request.indexes.map((index) => {
      const fields = fieldsByWeight(index);
      return {
        indexUid: uid(index.name),
        q,
        matchingStrategy: 'all',
        showRankingScore: true,
        attributesToRetrieve: ['key'],
        ...(filter === undefined ? {} : { filter }),
        ...(request.excerpts ? { attributesToCrop: fields, attributesToHighlight: fields, cropLength: CROP_LENGTH, highlightPreTag: MARK_START, highlightPostTag: MARK_END } : {}),
      };
    }),
  };
}

/** The excerpt of a hit: the first cropped field, in the order of the weights, that holds a match; else the first that holds text. */
function excerptOf(index: IndexInfo | undefined, formatted: unknown): readonly ExcerptSegment[] {
  if (index === undefined || !isRecord(formatted)) return [];
  const texts = fieldsByWeight(index)
    .map((field) => formatted[field])
    .filter((text): text is string => typeof text === 'string' && text !== '');
  const text = texts.find((candidate) => candidate.includes(MARK_START)) ?? texts[0];
  return text === undefined ? [] : excerptSegments(text);
}

/**
 * The hits and the total of a federated answer. An answer of another shape is `undefined`: the driver reports the search unavailable
 * rather than guess.
 * @internal
 */
export function parseMultiSearch(body: unknown, request: DriverQuery): DriverPage | undefined {
  if (!isRecord(body) || !Array.isArray(body['hits'])) return undefined;
  const total = body['totalHits'];
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return undefined;
  const indexes = new Map(request.indexes.map((index) => [index.name, index]));
  const hits: DriverHit[] = [];
  for (const hit of body['hits'] as unknown[]) {
    if (!isRecord(hit) || !isRecord(hit['_federation'])) return undefined;
    const index = hit['_federation']['indexUid'];
    const key = hit['key'];
    const score = typeof hit['_rankingScore'] === 'number' ? hit['_rankingScore'] : hit['_federation']['weightedRankingScore'];
    if (typeof index !== 'string' || (typeof key !== 'string' && typeof key !== 'number') || typeof score !== 'number' || !Number.isFinite(score)) return undefined;
    hits.push({ index, key, score, ...(request.excerpts ? { excerpt: excerptOf(indexes.get(index), hit['_formatted']) } : {}) });
  }
  return { hits, total };
}

/**
 * The `meilisearch` driver: each index is a Meilisearch index of the same name, written through the queued job and searched with one
 * federated multi-search. A write waits for its Meilisearch task, so a job never succeeds while Meilisearch still rejects the write.
 * Indexes come from `prepare()` (`marmeon search:rebuild`); a write never creates one.
 * @internal
 */
export class MeilisearchDriver implements SearchDriver {
  readonly writes = 'queue';
  readonly #client: MeilisearchClient;
  readonly #logger: Logger;

  constructor(client: MeilisearchClient, logger: Logger) {
    this.#client = client;
    this.#logger = logger;
  }

  async upsert(index: IndexInfo, documents: readonly StoredDocument[]): Promise<void> {
    const name = uid(index.name);
    // Meilisearch creates a missing index on a document write, with default settings that search every attribute. A delete between
    // this check and the write can still let that happen; `marmeon check` reports the wrong settings, and no lock is taken for it.
    await this.#write(name, () => this.#client.request('GET', ['indexes', name]), false);
    await this.#write(name, () => this.#client.request('POST', ['indexes', name, 'documents'], { query: { primaryKey: 'id' }, json: documents.map(meilisearchDocument) }));
  }

  async delete(index: IndexInfo, keys: readonly SearchKey[]): Promise<void> {
    const name = uid(index.name);
    await this.#write(name, () => this.#client.request('POST', ['indexes', name, 'documents', 'delete-batch'], { json: keys.map(documentId) }));
  }

  async flush(index: IndexInfo): Promise<void> {
    const name = uid(index.name);
    await this.#write(name, () => this.#client.request('DELETE', ['indexes', name, 'documents']));
  }

  async prepare(index: IndexInfo, target?: string): Promise<void> {
    const name = uid(target ?? index.name);
    try {
      await this.#client.waitForTask(await this.#client.request('POST', ['indexes'], { json: { uid: name, primaryKey: 'id' } }));
    } catch (error) {
      // Running again is no error: the index is there, and its settings are applied below.
      if (!(error instanceof SearchSyncError && error.code === 'index_already_exists')) throw this.#writeError(name, error);
    }
    await this.#write(name, () => this.#client.request('PATCH', ['indexes', name, 'settings'], { json: meilisearchSettings(index) }));
  }

  async swap(index: IndexInfo, target: string): Promise<void> {
    const name = uid(index.name);
    const other = uid(target);
    await this.#write(name, () => this.#client.request('POST', ['swap-indexes'], { json: [{ indexes: [name, other] }] }));
    // After the swap the target holds the old documents.
    await this.#write(other, () => this.#client.request('DELETE', ['indexes', other]));
  }

  async query(request: DriverQuery): Promise<Result<DriverPage, SearchFailure>> {
    const body = multiSearchBody(request);
    let answer: unknown;
    try {
      answer = await this.#client.request('POST', ['multi-search'], { json: body });
    } catch (error) {
      if (!(error instanceof MeilisearchError)) throw error;
      if (error.kind === 'missing-index') return err({ kind: 'missing-index', message: `An index this search names does not exist on Meilisearch yet. Run marmeon search:rebuild <index>. ${error.message}` });
      if (error.kind === 'unauthorized') this.#logger.warn('Meilisearch refused the API key or an action it lacks; check SEARCH_MEILISEARCH_API_KEY and its actions.');
      if (error.kind === 'rejected') this.#logger.warn(`Meilisearch refused a search. ${error.message} An index whose settings are older than its class needs marmeon search:rebuild.`);
      return err({ kind: 'unavailable', message: `The search could not run on Meilisearch. ${error.message}` });
    }
    const page = parseMultiSearch(answer, request);
    if (page === undefined) return err({ kind: 'unavailable', message: 'Meilisearch answered the search with a body that is no federated search result.' });
    return ok(page);
  }

  /** Sends a write and, unless `wait` is false, waits for its task; a missing index fails with the command that creates it. */
  async #write(name: string, send: () => Promise<unknown>, wait = true): Promise<void> {
    try {
      const answer = await send();
      if (wait) await this.#client.waitForTask(answer);
    } catch (error) {
      throw this.#writeError(name, error);
    }
  }

  #writeError(name: string, error: unknown): unknown {
    const missing = (error instanceof MeilisearchError && error.kind === 'missing-index') || (error instanceof SearchSyncError && error.code === 'index_not_found');
    if (missing) return new SearchSyncError(`The Meilisearch index "${name}" does not exist. Run marmeon search:rebuild ${name}.`, 'index_not_found');
    if (error instanceof MeilisearchError && error.kind === 'unauthorized') this.#logger.warn('Meilisearch refused the API key or an action it lacks; check SEARCH_MEILISEARCH_API_KEY and its actions.');
    return error;
  }
}
