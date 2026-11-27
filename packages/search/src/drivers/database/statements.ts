import { sql, type Connection } from '@marmeon/database';
import type { SearchKey, StoredDocument } from '../../driver.ts';
import type { IndexInfo } from '../../registry.ts';
import { keyId } from '../../search.ts';

/** The table of every index, made by the stub migration of the package. */
export const DOCUMENTS_TABLE = 'search_documents';
/** Every column of the table that the driver reads or writes. */
export const DOCUMENTS_COLUMNS = ['id', 'index_name', 'key', 'locale', 'config', 'filters', 'a', 'b', 'c', 'd', 'revision'] as const;
/** The columns that hold the text of the fields, by weight. */
export const TEXT_COLUMNS = ['a', 'b', 'c', 'd'] as const;

/** Documents per insert statement: 9 bound values each stays far below the limit of every driver. */
const UPSERT_CHUNK = 100;
/** Keys per delete statement. */
const DELETE_CHUNK = 500;

const WEIGHTS = ['A', 'B', 'C', 'D'] as const;

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
}

/** The text of each weight, A to D: the fields of that weight that have text, in the order the class declares them, one per line. */
export function weightedTexts(index: IndexInfo, document: StoredDocument): readonly [string, string, string, string] {
  const texts = WEIGHTS.map((weight) =>
    index.fields
      .filter((field) => field.weight === weight && Object.hasOwn(document.fields, field.name))
      .map((field) => document.fields[field.name]!)
      .join('\n'),
  );
  return [texts[0]!, texts[1]!, texts[2]!, texts[3]!];
}

/** The last document of each key, in the order the keys first came: one statement must not touch a row twice. */
function lastOfEachKey(documents: readonly StoredDocument[]): StoredDocument[] {
  const byKey = new Map<string, StoredDocument>();
  for (const document of documents) byKey.set(keyId(document.key), document);
  return [...byKey.values()];
}

/**
 * Stores documents of an index, replacing those with the same keys: one statement per 100 documents, every value bound. A replaced
 * row counts its revision up, so a rebuild can tell a row that changed while it ran. On SQLite the triggers of the stub keep the
 * FTS5 table in step. On Postgres, `configuration` gives each document's text search configuration (by its locale), stored in
 * `config`, and the statement writes `vector`: the text of each weight read with that configuration and weighted A to D.
 */
export async function upsertDocuments(db: Connection<any>, index: IndexInfo, documents: readonly StoredDocument[], configuration?: (locale: string | null) => string): Promise<void> {
  for (const chunk of chunks(lastOfEachKey(documents), UPSERT_CHUNK)) {
    const rows = chunk.map((document) => {
      const [a, b, c, d] = weightedTexts(index, document);
      const config = configuration ? configuration(document.locale) : null;
      return sql`(${index.name}, ${keyId(document.key)}, ${document.locale}, ${config}, ${JSON.stringify(document.filters)}, ${a}, ${b}, ${c}, ${d})`;
    });
    const update = sql`on conflict (index_name, key) do update set locale = excluded.locale, config = excluded.config, filters = excluded.filters,
      a = excluded.a, b = excluded.b, c = excluded.c, d = excluded.d`;
    if (configuration === undefined) {
      await sql`insert into search_documents (index_name, key, locale, config, filters, a, b, c, d) values ${sql.join(rows)}
        ${update}, revision = search_documents.revision + 1`.execute(db);
    } else {
      // The configuration is a bound name, cast to regconfig: a name the database does not know fails the statement, never runs.
      await sql`insert into search_documents (index_name, key, locale, config, filters, a, b, c, d, vector)
        select v.index_name, v.key, v.locale, v.config, v.filters::jsonb, v.a, v.b, v.c, v.d,
          setweight(to_tsvector(v.config::regconfig, v.a), 'A') || setweight(to_tsvector(v.config::regconfig, v.b), 'B') ||
          setweight(to_tsvector(v.config::regconfig, v.c), 'C') || setweight(to_tsvector(v.config::regconfig, v.d), 'D')
        from (values ${sql.join(rows)}) as v (index_name, key, locale, config, filters, a, b, c, d)
        ${update}, vector = excluded.vector, revision = search_documents.revision + 1`.execute(db);
    }
  }
}

/** Removes the documents of these keys from an index; a key the index does not hold removes nothing. */
export async function deleteDocuments(db: Connection<any>, index: IndexInfo, keys: readonly SearchKey[]): Promise<void> {
  for (const chunk of chunks(keys, DELETE_CHUNK)) {
    await sql`delete from search_documents where index_name = ${index.name} and key in (${sql.join(chunk.map(keyId))})`.execute(db);
  }
}

/** Removes every document of an index. */
export async function flushDocuments(db: Connection<any>, index: IndexInfo): Promise<void> {
  await sql`delete from search_documents where index_name = ${index.name}`.execute(db);
}

/** A stored document as the sweep of a rebuild sees it: its row id, its key and the revision it had when it was read. */
export interface StoredRevision {
  readonly id: number;
  readonly key: SearchKey;
  readonly revision: string;
}

/** The next documents of an index after the row id `after`, in the order of their ids, at most `limit`: one batch of the sweep. */
export async function documentsAfter(db: Connection<any>, index: IndexInfo, after: number, limit: number): Promise<StoredRevision[]> {
  // The revision as text: a bigint column reads as a string on Postgres, and the comparison below binds it back unchanged.
  const { rows } = await sql<{ id: number | string; key: string; revision: string | number }>`select id, key, cast(revision as text) as revision from search_documents
    where index_name = ${index.name} and id > ${after} order by id limit ${limit}`.execute(db);
  return rows.map((row) => ({ id: Number(row.id), key: JSON.parse(row.key) as SearchKey, revision: String(row.revision) }));
}

/**
 * Removes these documents, each only while it still has the revision it was read with: a document the app wrote again since then
 * has a new revision and stays. Returns how many it removed.
 */
export async function deleteUnchanged(db: Connection<any>, index: IndexInfo, documents: readonly StoredRevision[]): Promise<number> {
  let removed = 0;
  for (const document of documents) {
    const result = await sql`delete from search_documents where index_name = ${index.name} and id = ${document.id} and cast(revision as text) = ${document.revision}`.execute(db);
    removed += Number(result.numAffectedRows ?? 0n);
  }
  return removed;
}
