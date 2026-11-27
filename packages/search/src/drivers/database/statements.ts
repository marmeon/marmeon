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

/**
 * Stores documents of an index, replacing those with the same keys: one statement per 100 documents, every value bound. A replaced
 * row counts its revision up, so a rebuild can tell a row that changed while it ran.
 */
export async function upsertDocuments(db: Connection<any>, index: IndexInfo, documents: readonly StoredDocument[]): Promise<void> {
  for (const chunk of chunks(documents, UPSERT_CHUNK)) {
    const rows = chunk.map((document) => {
      const [a, b, c, d] = weightedTexts(index, document);
      return sql`(${index.name}, ${keyId(document.key)}, ${document.locale}, ${null}, ${JSON.stringify(document.filters)}, ${a}, ${b}, ${c}, ${d})`;
    });
    await sql`insert into search_documents (index_name, key, locale, config, filters, a, b, c, d) values ${sql.join(rows)}
      on conflict (index_name, key) do update set locale = excluded.locale, config = excluded.config, filters = excluded.filters,
      a = excluded.a, b = excluded.b, c = excluded.c, d = excluded.d, revision = search_documents.revision + 1`.execute(db);
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
