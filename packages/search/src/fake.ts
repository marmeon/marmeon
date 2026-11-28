import { AssertionError } from 'node:assert';
import { err, ok, type Result } from '@marmeon/core';
import type { DriverHit, DriverPage, DriverQuery, SearchDriver, SearchFailure, SearchKey, StoredDocument } from './driver.ts';
import type { IndexInfo } from './registry.ts';
import { keyId, MAX_REACHABLE_HITS } from './search.ts';
import type { KeyOf, SearchIndexClass, SearchWeight } from './search-index.ts';
import type { ExcerptSegment, FilterScalar } from './terms.ts';

/** One write the fake took, in order: the index by name, the keys, and for `upsert` the documents as `Search` built them. */
export interface RecordedSearchWrite {
  readonly method: 'upsert' | 'delete' | 'flush';
  readonly index: string;
  /** The keys written or removed; empty for `flush`. */
  readonly keys: readonly SearchKey[];
  /** The documents of an `upsert`; empty otherwise. */
  readonly documents: readonly StoredDocument[];
}

const SCORES: Readonly<Record<SearchWeight, number>> = { highest: 4, high: 3, normal: 2, low: 1 };
const FAILURE_KINDS: readonly unknown[] = ['unavailable', 'missing-index'];
// The token shape of `terms.ts`: a word of a field is found the way a word of the term is.
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;
/** The characters of field text an excerpt shows before its first match, and in all. */
const EXCERPT_BEFORE = 60;
const EXCERPT_LENGTH = 200;

/** A word compared without case and without diacritics: `Häuser` and `hauser` are one word. */
const fold = (word: string): string => word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** The name of an index class, read from its static `index`; anything else is no index class. */
function indexName(Index: SearchIndexClass, caller: string): string {
  const name = (Index as { readonly index?: unknown } | null | undefined)?.index;
  if (typeof Index !== 'function' || typeof name !== 'string') throw new TypeError(`app.search.${caller}() takes a search index class (a class that extends SearchIndex) first.`);
  return name;
}

/** A key as an assertion message shows it: as JSON, cut at 80 characters. */
const shownKey = (key: SearchKey): string => {
  const text = keyId(key);
  return text.length <= 80 ? text : `${text.slice(0, 80)}…`;
};

/** A filter value of a search as the fake compares it: a string, a finite number or a boolean, else a `TypeError`. */
function filterScalar(value: unknown, name: string): FilterScalar {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new TypeError(`The search filter "${name}" must be a string, a finite number or a boolean, or a non-empty list of them.`);
}

/**
 * The filters of a search, checked for the shapes `Search.query()` refuses: an object that is not plain, a key that is not its own,
 * enumerable string key, an empty list and a value that is no filter value. Reached only by a test that calls the fake itself.
 */
function checkedFilters(filters: unknown): [string, readonly FilterScalar[]][] {
  // Only own enumerable string keys are read: a filter held anywhere else would drop out of the search, so anything else is refused.
  const prototype: unknown = typeof filters === 'object' && filters !== null ? Object.getPrototypeOf(filters) : undefined;
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(filters as object).length !== Object.keys(filters as object).length) {
    throw new TypeError('The search filters must be a plain object with enumerable string keys.');
  }
  return Object.entries(filters as Record<string, unknown>).map(([name, value]) => {
    if (!Array.isArray(value)) return [name, [filterScalar(value, name)]];
    if (value.length === 0) throw new TypeError(`The search filter "${name}" got an empty list, which would match nothing.`);
    // Array.from hands a hole to the check as undefined.
    return [name, Array.from(value as readonly unknown[], (one) => filterScalar(one, name))];
  });
}

/** Whether a document carries, for every filter of the search, its value or one of its values — compared with type, `1` is not `true`. */
function matchesFilters(carried: Readonly<Record<string, FilterScalar>>, wanted: readonly (readonly [string, readonly FilterScalar[]])[]): boolean {
  for (const [name, values] of wanted) {
    if (!Object.hasOwn(carried, name)) return false;
    if (!values.some((entry) => entry === carried[name])) return false;
  }
  return true;
}

interface Word {
  readonly start: number;
  readonly end: number;
  readonly folded: string;
}

const wordsOf = (text: string): Word[] => [...text.matchAll(WORD)].map((match) => ({ start: match.index, end: match.index + match[0].length, folded: fold(match[0]) }));

/** Whether a field word is the search token: equal, or for the last token of a prefix search its start. */
const hits = (word: Word, token: string, asPrefix: boolean): boolean => word.folded === token || (asPrefix && word.folded.startsWith(token));

/** A position in `text` moved back off the second half of a surrogate pair. */
const onCodePoint = (text: string, position: number): number => (position > 0 && position < text.length && /[\uDC00-\uDFFF]/.test(text[position]!) ? position - 1 : position);

/** The excerpt of one field: a window of its text around the first match, the matching words marked, cut ends shown as `…`. */
function excerptOf(text: string, words: readonly Word[], matched: (word: Word) => boolean): readonly ExcerptSegment[] {
  const first = words.find(matched);
  const start = onCodePoint(text, first === undefined ? 0 : Math.max(0, first.start - EXCERPT_BEFORE));
  const end = onCodePoint(text, Math.min(text.length, start + EXCERPT_LENGTH));
  const segments: { text: string; match: boolean }[] = [];
  const push = (part: string, match: boolean) => {
    if (part === '') return;
    const last = segments.at(-1);
    if (last?.match === match) last.text += part;
    else segments.push({ text: part, match });
  };
  if (start > 0) push('…', false);
  let at = start;
  for (const word of words) {
    if (word.start < start || word.end > end || !matched(word)) continue;
    push(text.slice(at, word.start), false);
    push(text.slice(word.start, word.end), true);
    at = word.end;
  }
  push(text.slice(at, end), false);
  if (end < text.length) push('…', false);
  return Object.freeze(segments.map((segment) => Object.freeze(segment)));
}

/**
 * The search driver of tests: keeps every index in memory and records every write, so a test asserts what the app indexed —
 * `app.search` of a test app (`@marmeon/testing`). See `docs/fakes.md#search`.
 * The real `Search` stays in front of it: the rows are read through `source()`, `includes()` and `toDocument()` run and every input is
 * checked as in production. It writes after the commit, so a rollback records nothing.
 * A search finds a document when it holds every word of the term, compared without case and diacritics (the last word as the start of
 * a word with `prefix`). The score adds up the weights of the fields that matched (`highest` = 4 … `low` = 1). Filters (compared with their
 * type), the locale and the cap of 1000 hits follow `docs/full-text-search.md#searching`.
 */
export class SearchFake implements SearchDriver {
  readonly writes = 'after-commit' as const;
  readonly #indexes = new Map<string, Map<string, StoredDocument>>();
  readonly #written: RecordedSearchWrite[] = [];
  readonly #failures: SearchFailure[] = [];

  async upsert(index: IndexInfo, documents: readonly StoredDocument[]): Promise<void> {
    const stored = this.#indexes.get(index.name) ?? new Map<string, StoredDocument>();
    const copies = documents.map((document) => Object.freeze({ key: document.key, locale: document.locale, fields: Object.freeze({ ...document.fields }), filters: Object.freeze({ ...document.filters }) }));
    for (const document of copies) stored.set(keyId(document.key), document);
    this.#indexes.set(index.name, stored);
    this.#record('upsert', index.name, copies.map((document) => document.key), copies);
  }

  async delete(index: IndexInfo, keys: readonly SearchKey[]): Promise<void> {
    for (const key of keys) this.#indexes.get(index.name)?.delete(keyId(key));
    this.#record('delete', index.name, [...keys], []);
  }

  async flush(index: IndexInfo): Promise<void> {
    this.#indexes.delete(index.name);
    this.#record('flush', index.name, [], []);
  }

  async query(request: DriverQuery): Promise<Result<DriverPage, SearchFailure>> {
    const failure = this.#failures.shift();
    if (failure !== undefined) return err(failure);
    const filters = checkedFilters(request.filters);
    const tokens = request.tokens.map(fold);
    const found: DriverHit[] = [];
    for (const index of request.indexes) {
      const weights = new Map(index.fields.map((field) => [field.name, field.weight]));
      for (const document of this.#indexes.get(index.name)?.values() ?? []) {
        // With a locale, documents of that locale and documents without one; without, every document.
        if (request.locale !== undefined && document.locale !== null && document.locale !== request.locale) continue;
        if (!matchesFilters(document.filters, filters)) continue;
        const fields = Object.entries(document.fields).filter(([name]) => weights.has(name)).map(([name, text]) => ({ name, text, words: wordsOf(text) }));
        const asPrefix = (position: number) => request.prefix && position === tokens.length - 1;
        const matched = (word: Word) => tokens.some((token, position) => hits(word, token, asPrefix(position)));
        if (!tokens.every((token, position) => fields.some((field) => field.words.some((word) => hits(word, token, asPrefix(position)))))) continue;
        const matching = fields.filter((field) => field.words.some(matched));
        const score = matching.reduce((sum, field) => sum + SCORES[weights.get(field.name)!], 0);
        let excerpt: readonly ExcerptSegment[] | undefined;
        if (request.excerpts) {
          // The best field that matched: the highest weight, then the order of the declaration.
          const order = index.fields.map((field) => field.name);
          const best = [...matching].sort((a, b) => SCORES[weights.get(b.name)!] - SCORES[weights.get(a.name)!] || order.indexOf(a.name) - order.indexOf(b.name))[0];
          if (best !== undefined) excerpt = excerptOf(best.text, best.words, matched);
        }
        found.push({ index: index.name, key: document.key, score, ...(excerpt === undefined ? {} : { excerpt }) });
      }
    }
    // Best first; a tie keeps the order of the indexes and of the writes, so a test sees one order every run.
    const ranked = found.map((hit, position) => ({ hit, position })).sort((a, b) => b.hit.score - a.hit.score || a.position - b.position).map(({ hit }) => hit);
    return ok({ hits: ranked.slice(request.offset, request.offset + request.limit), total: Math.min(ranked.length, MAX_REACHABLE_HITS) });
  }

  /** Every write the fake took, in order — removals before the documents of one `index()` call, as `Search` writes them. */
  get written(): readonly RecordedSearchWrite[] {
    return [...this.#written];
  }

  /** The documents the index holds now, in the order they were first written. */
  documents(Index: SearchIndexClass): readonly StoredDocument[] {
    return [...(this.#indexes.get(indexName(Index, 'documents'))?.values() ?? [])];
  }

  /**
   * Makes the next `times` searches (default one) fail with `kind` — `unavailable` (default) or `missing-index` — as an `err` of
   * `search.query()`. Writes are not affected.
   */
  failNext(kind: SearchFailure['kind'] = 'unavailable', times = 1): this {
    if (!FAILURE_KINDS.includes(kind)) throw new TypeError(`failNext() takes 'unavailable' or 'missing-index', not ${JSON.stringify(kind) ?? String(kind)}.`);
    if (!Number.isSafeInteger(times) || times < 1) throw new TypeError(`failNext() takes a positive whole number of times, not ${String(times)}.`);
    const message = kind === 'unavailable' ? 'The fake search driver failed this search.' : 'The fake search driver reports the index as missing.';
    for (let count = 0; count < times; count += 1) this.#failures.push(Object.freeze({ kind, message }));
    return this;
  }

  /**
   * Passes when the index holds the document of `key` now, or — given a function — a document for which it returns `true`.
   * A row `includes()` refused, or one indexed in a transaction that rolled back, is not held.
   */
  assertIndexed<I extends SearchIndexClass>(Index: I, match: KeyOf<I> | ((document: StoredDocument) => boolean)): this {
    const name = indexName(Index, 'assertIndexed');
    const documents = this.documents(Index);
    if (typeof match === 'function') {
      if (!documents.some((document) => (match as (document: StoredDocument) => unknown)(document) === true)) {
        throw new AssertionError({ message: `Expected the search index "${name}" to hold a document matching the function; it holds ${documents.length}.` });
      }
      return this;
    }
    if (typeof match !== 'string' && typeof match !== 'number') throw new TypeError('app.search.assertIndexed() takes a key (a string or a number) or a function of the document.');
    if (!documents.some((document) => keyId(document.key) === keyId(match))) {
      throw new AssertionError({ message: `Expected the search index "${name}" to hold the document ${shownKey(match)}; it holds ${documents.length === 0 ? 'none' : documents.map((document) => shownKey(document.key)).slice(0, 10).join(', ')}.` });
    }
    return this;
  }

  /** Passes when a removal of `key` was written — a removal of the key or a flush of the index — and the index does not hold it now. */
  assertRemoved<I extends SearchIndexClass>(Index: I, key: KeyOf<I>): this {
    const name = indexName(Index, 'assertRemoved');
    if (typeof key !== 'string' && typeof key !== 'number') throw new TypeError('app.search.assertRemoved() takes a key (a string or a number).');
    const id = keyId(key);
    if (this.documents(Index).some((document) => keyId(document.key) === id)) throw new AssertionError({ message: `Expected the document ${shownKey(key)} to be removed from the search index "${name}", but the index holds it.` });
    const removed = this.#written.some((write) => write.index === name && (write.method === 'flush' || (write.method === 'delete' && write.keys.some((entry) => keyId(entry) === id))));
    if (!removed) throw new AssertionError({ message: `Expected the document ${shownKey(key)} to be removed from the search index "${name}", but no removal of it was written.` });
    return this;
  }

  /** Passes when no document was written to any index — removals and flushes do not count. */
  assertNothingIndexed(): this {
    const upserts = this.#written.filter((write) => write.method === 'upsert');
    if (upserts.length > 0) {
      const names = [...new Set(upserts.map((write) => `"${write.index}"`))].join(', ');
      throw new AssertionError({ message: `Expected no document to be indexed, but ${upserts.reduce((sum, write) => sum + write.keys.length, 0)} were (${names}).` });
    }
    return this;
  }

  #record(method: RecordedSearchWrite['method'], index: string, keys: readonly SearchKey[], documents: readonly StoredDocument[]): void {
    this.#written.push(Object.freeze({ method, index, keys: Object.freeze(keys), documents: Object.freeze(documents) }));
  }
}
