import { inTransaction, ok, type Result } from '@marmeon/core';
import { sql, type Connections } from '@marmeon/database';
import type { DriverHit, DriverPage, DriverQuery, SearchDriver, SearchFailure, SearchKey, StoredDocument } from '../driver.ts';
import type { IndexInfo } from '../registry.ts';
import type { FilterScalar } from '../terms.ts';

/** One call a driver received, and whether it ran inside a transaction. */
export interface DriverCall {
  readonly method: 'upsert' | 'delete' | 'query' | 'flush';
  readonly index: string;
  readonly keys: readonly SearchKey[];
  readonly inTransaction: boolean;
}

const id = (key: SearchKey): string => JSON.stringify(key);

/**
 * A search driver for the package's own tests. With `writes: 'transaction'` it keeps its documents in the table
 * `memory_search_documents` of the app's database, so a rollback of the caller takes them back; otherwise in memory. It matches a
 * document when every token is a word of one of its fields (a prefix of a word for the last token with `prefix`).
 */
export class MemoryDriver implements SearchDriver {
  readonly writes: SearchDriver['writes'];
  readonly calls: DriverCall[] = [];
  /** Every request `query()` received. */
  readonly queries: DriverQuery[] = [];
  /** What the next `query()` answers instead of searching. */
  failure: SearchFailure | undefined;
  readonly #memory = new Map<string, Map<string, StoredDocument>>();
  readonly #connections: (() => Connections) | undefined;

  constructor(writes: SearchDriver['writes'], connections?: () => Connections) {
    this.writes = writes;
    this.#connections = connections;
    if (writes === 'transaction' && !connections) throw new TypeError('A MemoryDriver that writes in the transaction needs the connections.');
  }

  /** Creates the table a transaction driver writes to. */
  static async createTable(connections: Connections): Promise<void> {
    await sql`create table memory_search_documents (index_name text not null, key text not null, document text not null, primary key (index_name, key))`.execute(connections.get());
  }

  #record(method: DriverCall['method'], index: string, keys: readonly SearchKey[]): void {
    this.calls.push({ method, index, keys, inTransaction: inTransaction() });
  }

  async upsert(index: IndexInfo, documents: readonly StoredDocument[]): Promise<void> {
    this.#record('upsert', index.name, documents.map((document) => document.key));
    if (this.#connections) {
      const db = this.#connections().get();
      for (const document of documents) {
        await sql`insert into memory_search_documents (index_name, key, document) values (${index.name}, ${id(document.key)}, ${JSON.stringify(document)})
          on conflict (index_name, key) do update set document = excluded.document`.execute(db);
      }
      return;
    }
    const stored = this.#memory.get(index.name) ?? new Map<string, StoredDocument>();
    for (const document of documents) stored.set(id(document.key), document);
    this.#memory.set(index.name, stored);
  }

  async delete(index: IndexInfo, keys: readonly SearchKey[]): Promise<void> {
    this.#record('delete', index.name, keys);
    if (this.#connections) {
      const db = this.#connections().get();
      for (const key of keys) await sql`delete from memory_search_documents where index_name = ${index.name} and key = ${id(key)}`.execute(db);
      return;
    }
    for (const key of keys) this.#memory.get(index.name)?.delete(id(key));
  }

  async flush(index: IndexInfo): Promise<void> {
    this.#record('flush', index.name, []);
    if (this.#connections) await sql`delete from memory_search_documents where index_name = ${index.name}`.execute(this.#connections().get());
    else this.#memory.delete(index.name);
  }

  /** The documents of an index, by key. */
  async documents(index: string): Promise<StoredDocument[]> {
    if (this.#connections) {
      const { rows } = await sql<{ document: string }>`select document from memory_search_documents where index_name = ${index} order by key`.execute(this.#connections().get());
      return rows.map((row) => JSON.parse(row.document) as StoredDocument);
    }
    return [...(this.#memory.get(index)?.values() ?? [])];
  }

  async query(request: DriverQuery): Promise<Result<DriverPage, SearchFailure>> {
    this.#record('query', request.indexes.map((index) => index.name).join(','), []);
    this.queries.push(request);
    if (this.failure) return { ok: false, error: this.failure };
    const hits: DriverHit[] = [];
    for (const index of request.indexes) {
      for (const document of await this.documents(index.name)) {
        if (request.locale !== undefined && document.locale !== null && document.locale !== request.locale) continue;
        if (!matchesFilters(document.filters, request.filters)) continue;
        const words = Object.values(document.fields).join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u);
        const found = request.tokens.every((token, position) => {
          const wanted = token.toLowerCase();
          const last = position === request.tokens.length - 1;
          return words.some((word) => word === wanted || (request.prefix && last && word.startsWith(wanted)));
        });
        if (found) hits.push({ index: index.name, key: document.key, score: 1, ...(request.excerpts ? { excerpt: [{ text: Object.values(document.fields)[0] ?? '', match: true }] } : {}) });
      }
    }
    return ok({ hits: hits.slice(request.offset, request.offset + request.limit), total: hits.length });
  }
}

function matchesFilters(carried: Readonly<Record<string, FilterScalar>>, wanted: DriverQuery['filters']): boolean {
  for (const [name, value] of Object.entries(wanted)) {
    if (!Object.hasOwn(carried, name)) return false;
    const values: readonly FilterScalar[] = Array.isArray(value) ? value : [value as FilterScalar];
    if (!values.some((entry) => entry === carried[name])) return false;
  }
  return true;
}
