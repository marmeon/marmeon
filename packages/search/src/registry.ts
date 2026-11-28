import { withCode } from '@marmeon/core/internal';
import { SearchSetupError } from './errors.ts';
import type { SearchIndexClass, SearchWeight } from './search-index.ts';

/** What a driver knows of an index: its name, its key column, its fields with their weights and its filters. Frozen. */
export interface IndexInfo {
  readonly name: string;
  readonly key: string;
  readonly fields: readonly { readonly name: string; readonly weight: SearchWeight }[];
  readonly filters: readonly string[];
}

/** @internal What an index name is: lowercase letters, digits, `_` and `-`, starting with a letter, at most 64 characters. */
export const INDEX_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
// `constructor` matches the pattern too and is refused on its own, like every name Object.prototype has.
const ATTRIBUTE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** @internal The weights from the one that counts most to the one that counts least. */
export const WEIGHTS = ['highest', 'high', 'normal', 'low'] as const satisfies readonly SearchWeight[];
/**
 * @internal The tsvector letter of each weight, which the rebuild fingerprint hashes instead of the name: the fingerprint describes
 * what the documents were written with, and the `setweight` calls of `statements.ts` write these letters.
 */
export const WEIGHT_LEVELS: Readonly<Record<SearchWeight, 'A' | 'B' | 'C' | 'D'>> = Object.freeze({ highest: 'A', high: 'B', normal: 'C', low: 'D' });
const MAX_FIELDS = 32;
const MAX_FILTERS = 32;

function setup(message: string): SearchSetupError {
  return new SearchSetupError(withCode('Q9', message));
}

/** A class's name for a message: a non-empty string `name`, never a symbol, a method or its source. */
function nameOf(value: object): string {
  const { name } = value as { readonly name?: unknown };
  return typeof name === 'string' && name !== '' ? name : '(unnamed class)';
}

/** What a value is, for a message: a short string quoted, anything else only its type, never its content. */
function shown(value: unknown): string {
  if (typeof value === 'string') return value.length <= 80 ? JSON.stringify(value) : `${JSON.stringify(value.slice(0, 80))}…`;
  if (value === undefined || value === null) return String(value);
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** A static of the class, read once, so the check and the frozen copy see one value. */
function read(Index: SearchIndexClass, key: string): unknown {
  return (Index as unknown as Record<string, unknown>)[key];
}

/** Checks one class against every rule of an index definition and returns what drivers get of it. */
function infoOf(Index: SearchIndexClass, source: string): IndexInfo {
  const label = `${nameOf(Index)} (${source})`;
  const name = read(Index, 'index');
  if (typeof name !== 'string' || !INDEX_NAME.test(name)) {
    throw setup(`${label} has static index = ${shown(name)}, but an index name is lowercase letters, digits, "_" and "-", starting with a letter, at most 64 characters: static index = 'pages'.`);
  }
  const key = read(Index, 'key');
  if (typeof key !== 'string' || key === '') throw setup(`${label} has static key = ${shown(key)}, but the key is the name of a column of its rows: static key = 'id'.`);
  // A name Object.prototype has would read an inherited value from a row that lacks the column.
  if (Object.hasOwn(Object.prototype, key)) throw setup(`${label} has static key = ${shown(key)}, a name every object has, so a row without that column would still seem to have it.`);

  const fields = read(Index, 'fields');
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw setup(`${label} has static fields = ${shown(fields)}, but fields are an object of field names and weights: static fields = { title: 'highest', body: 'normal' }.`);
  }
  const entries = Object.entries(fields);
  if (entries.length < 1 || entries.length > MAX_FIELDS) throw setup(`${label} declares ${entries.length} fields, but an index has 1 to ${MAX_FIELDS}.`);
  for (const [field, weight] of entries) {
    if (!ATTRIBUTE_NAME.test(field) || Object.hasOwn(Object.prototype, field)) {
      throw setup(`${label} declares the field ${shown(field)}, but a field name is lowercase letters, digits and "_", starting with a letter, at most 64 characters, and not "constructor".`);
    }
    if (typeof weight !== 'string' || !(WEIGHTS as readonly string[]).includes(weight)) {
      throw setup(`${label} gives the field "${field}" the weight ${shown(weight)}, but a weight is 'highest', 'high', 'normal' or 'low'.`);
    }
  }

  const declared = read(Index, 'filters');
  const filters = declared === undefined ? [] : declared;
  if (!Array.isArray(filters)) throw setup(`${label} has static filters = ${shown(filters)}, but filters are a list of attribute names: static filters = ['kind'].`);
  if (filters.length > MAX_FILTERS) throw setup(`${label} declares ${filters.length} filters, but an index has at most ${MAX_FILTERS}.`);
  const seen = new Set<string>();
  // for…of, not forEach: a hole in the list is an entry (undefined) and is refused.
  for (const filter of filters as readonly unknown[]) {
    if (typeof filter !== 'string' || !ATTRIBUTE_NAME.test(filter) || Object.hasOwn(Object.prototype, filter)) {
      throw setup(`${label} declares the filter ${shown(filter)}, but a filter name is lowercase letters, digits and "_", starting with a letter, at most 64 characters, and not "constructor".`);
    }
    if (filter === 'locale') throw setup(`${label} declares the filter "locale", but every search already narrows by locale: remove it from static filters.`);
    if (seen.has(filter)) throw setup(`${label} declares the filter "${filter}" twice.`);
    seen.add(filter);
  }

  const connection = read(Index, 'connection');
  if (connection !== undefined && connection !== 'default') {
    throw setup(`${label} has static connection = ${shown(connection)}, but an index reads its rows on the default connection only: remove static connection.`);
  }

  const prototype = (Index as { readonly prototype?: unknown }).prototype;
  for (const method of ['source', 'toDocument'] as const) {
    const value = typeof prototype === 'object' && prototype !== null ? (prototype as Record<string, unknown>)[method] : undefined;
    if (typeof value !== 'function') throw setup(`${label} has no method ${method}(): an index class defines source() and toDocument() as methods.`);
  }
  const includes = typeof prototype === 'object' && prototype !== null ? (prototype as Record<string, unknown>)['includes'] : undefined;
  // A value that is no function would read as "every row belongs" to a caller that skips a missing method: refused here instead.
  if (includes !== undefined && typeof includes !== 'function') throw setup(`${label} has an includes that is no method: define includes(row) as a method, or leave it out.`);

  return Object.freeze({
    name,
    key,
    fields: Object.freeze(entries.map(([field, weight]) => Object.freeze({ name: field, weight: weight as SearchWeight }))),
    filters: Object.freeze([...seen]),
  });
}

/**
 * The search indexes of the app: those of the modules' `searchIndexes` and the providers' `static searchIndexes`, each checked at the
 * start. Knows a class by its identity, never by its name. See `docs/full-text-search.md#defining-an-index`.
 */
export class SearchIndexes {
  readonly #byClass = new Map<SearchIndexClass, IndexInfo>();
  readonly #byName = new Map<string, { readonly Index: SearchIndexClass; readonly source: string }>();

  /**
   * @internal Registers the classes of one list; `source` names where they come from in messages (`module pages`, `provider
   * CmsServiceProvider`). A list that is no array of classes, a broken definition or a name two classes share stops the start (Q9).
   */
  add(list: unknown, source: string): this {
    if (list === undefined) return this;
    if (!Array.isArray(list)) throw setup(`${source} has searchIndexes = ${shown(list)}, but searchIndexes is a list of index classes: searchIndexes: [PageIndex].`);
    let position = 0;
    // A counter over the iterator, so a hole in the list is an entry (undefined) too.
    for (const Index of list as readonly unknown[]) {
      if (typeof Index !== 'function') throw setup(`${source} lists ${shown(Index)} at searchIndexes[${position}], which is not an index class.`);
      position++;
      const Class = Index as SearchIndexClass;
      // The same class twice — from a module and a provider, or listed again — is one index.
      if (this.#byClass.has(Class)) continue;
      const info = infoOf(Class, source);
      const existing = this.#byName.get(info.name);
      if (existing !== undefined) {
        throw setup(
          `Two search indexes are named "${info.name}": ${nameOf(existing.Index)} (${existing.source}) and ${nameOf(Class)} (${source}). The name is how the index is stored — give each its own static index.`,
        );
      }
      this.#byClass.set(Class, info);
      this.#byName.set(info.name, { Index: Class, source });
    }
    return this;
  }

  /** Every registered index class, in the order they were registered. */
  all(): readonly SearchIndexClass[] {
    return [...this.#byClass.keys()];
  }

  /** The class registered under an index name, `undefined` for a name no class has. */
  get(name: string): SearchIndexClass | undefined {
    return this.#byName.get(name)?.Index;
  }

  /** What drivers know of a registered index, as it was checked at the start. A class that is not registered is a `TypeError`. */
  info(Index: SearchIndexClass): IndexInfo {
    const info = this.#byClass.get(Index);
    if (info === undefined) {
      throw new TypeError(`${typeof Index === 'function' ? nameOf(Index) : shown(Index)} is not a registered search index. List it in a module's searchIndexes or a provider's static searchIndexes.`);
    }
    return info;
  }
}
