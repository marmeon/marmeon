import { sql, type Connection } from '@marmeon/database';
import type { DriverHit, DriverPage, DriverQuery, SearchKey } from '../../driver.ts';
import { excerptSegments, fts5Match, type FilterScalar } from '../../terms.ts';
import { UNIQUE_INDEX } from './statements.ts';

/** How many matches the count looks at: one more than a search reaches, so `Search` can cap the total at 1000. */
const COUNT_LIMIT = 1001;
/** The name of a filter as it may reach a JSON path: what an index may declare. */
const FILTER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** The words an excerpt holds around the match. */
const EXCERPT_TOKENS = 12;

/** A filter value in the JSON form it is stored in: comparing JSON, not SQL values, keeps `true` from matching `1` and `'1'` from `1`. */
const json = (value: FilterScalar): string => JSON.stringify(value);

/** The JSON path of a filter, bound as a value; the name is checked again, since it becomes part of a path. */
function filterPath(name: string): string {
  if (!FILTER_NAME.test(name)) throw new TypeError(`The search filter ${JSON.stringify(name)} is no declared filter name.`);
  return `$."${name}"`;
}

/** The conditions every search shares, for the page and for the count: the match, the indexes, the locale and the filters. */
function conditions(request: DriverQuery) {
  const filters: unknown = request.filters;
  // Only own enumerable string keys are read: a filter held anywhere else would drop out of the search, so anything else is refused.
  const prototype: unknown = typeof filters === 'object' && filters !== null ? Object.getPrototypeOf(filters) : undefined;
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(filters as object).length !== Object.keys(filters as object).length) {
    throw new TypeError('The search filters must be a plain object with enumerable string keys.');
  }
  const parts = [
    sql`search_documents_fts match ${fts5Match(request.tokens, request.prefix)}`,
    sql`d.index_name in (${sql.join(request.indexes.map((index) => index.name))})`,
  ];
  if (request.locale !== undefined) parts.push(sql`(d.locale = ${request.locale} or d.locale is null)`);
  for (const [name, value] of Object.entries(request.filters)) {
    const path = filterPath(name);
    // A document that lacks the filter gives NULL here, which matches no value.
    if (Array.isArray(value)) parts.push(sql`(d.filters -> ${path}) in (${sql.join((value as readonly FilterScalar[]).map((one) => sql`json(${json(one)})`))})`);
    else parts.push(sql`(d.filters -> ${path}) = json(${json(value as FilterScalar)})`);
  }
  return sql.join(parts, sql` and `);
}

/** The text columns with the weights of A to D, as the score counts them. */
const WEIGHTED_COLUMNS = [
  ['a', 10],
  ['b', 4],
  ['c', 2],
  ['d', 1],
] as const;

/**
 * The score of a document, local to it and read from the index alone: for each text column, its weight times the number of tokens
 * of the term that occur in that column. Each `column : "token"` query runs once per statement as a lookup in the index; the
 * column is one of the fixed names above, and `fts5Match()` checks the token again (no `"`), so the input cannot reach FTS5 syntax. bm25
 * would weigh with statistics of the whole table, which documents of other tenants and indexes move, and `highlight()` would read
 * and split the text of every match.
 */
function score(request: DriverQuery) {
  const last = request.tokens.length - 1;
  const terms = WEIGHTED_COLUMNS.flatMap(([column, weight]) =>
    request.tokens.map(
      (token, i) =>
        sql`${sql.lit(weight)} * (d.id in (select rowid from search_documents_fts where search_documents_fts match ${`{${column}} : ${fts5Match([token], request.prefix && i === last)}`}))`,
    ),
  );
  return sql.join(terms, sql` + `);
}

interface Row {
  readonly id: number;
  readonly index_name: string;
  readonly key: string;
  readonly score: number;
}

/**
 * The excerpts of the rows of one page, by id: `snippet()` runs in a statement of its own, only for these rows, since SQLite
 * works out every selected column before it sorts and cuts. The statement applies every condition of the search again: a row
 * whose filters changed since the page was read gets no excerpt, so its new text never reaches a user who may not see it.
 */
async function excerpts(db: Connection<any>, request: DriverQuery, ids: readonly number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<{ id: number; excerpt: string | null }>`select d.id as id, snippet(search_documents_fts, -1, char(57344), char(57345), '…', ${sql.lit(EXCERPT_TOKENS)}) as excerpt
    from search_documents_fts join search_documents d on d.id = search_documents_fts.rowid
    where ${conditions(request)} and d.id in (${sql.join(ids)})`.execute(db);
  return new Map(rows.map((row) => [Number(row.id), row.excerpt ?? '']));
}

/**
 * One search on SQLite: FTS5 matches the quoted tokens, the rows that pass the indexes, the locale and every filter are ranked by a
 * score local to each document (weights 10, 4, 2 and 1 for A to D), `snippet()` runs only for the rows of the page, and the count
 * looks at no more than 1001 matches.
 */
export async function querySqlite(db: Connection<any>, request: DriverQuery): Promise<DriverPage> {
  const where = conditions(request);
  const { rows } = await sql<Row>`select d.id as id, d.index_name as index_name, d.key as key, (${score(request)}) as score
    from search_documents_fts join search_documents d on d.id = search_documents_fts.rowid
    where ${where}
    order by score desc, d.id desc
    limit ${request.limit} offset ${request.offset}`.execute(db);
  const texts = request.excerpts ? await excerpts(db, request, rows.map((row) => Number(row.id))) : undefined;
  const hits = rows.map((row): DriverHit => ({
    index: row.index_name,
    key: JSON.parse(row.key) as SearchKey,
    score: Number(row.score),
    ...(texts ? { excerpt: excerptSegments(texts.get(Number(row.id)) ?? '') } : {}),
  }));
  // A first page that is not full holds every match: no count needed.
  if (request.offset === 0 && hits.length < request.limit) return { hits, total: hits.length };
  const counted = await sql<{ total: number }>`select count(*) as total from (select 1
    from search_documents_fts join search_documents d on d.id = search_documents_fts.rowid
    where ${where}
    limit ${COUNT_LIMIT})`.execute(db);
  return { hits, total: Number(counted.rows[0]?.total ?? 0) };
}

/** Which of the schema objects of the search migration a SQLite database lacks or has in another form, by name and what is wrong. */
export async function sqliteSchemaGaps(db: Connection<any>): Promise<{ readonly name: string; readonly problem: 'missing' | 'not-fts5' | 'other-definition' }[]> {
  const { rows } = await sql<{ type: string; name: string; tbl_name: string; sql: string | null }>`select type, name, tbl_name, sql from sqlite_master
    where name in ('search_documents', 'search_rebuilds', 'search_documents_fts', 'search_documents_ai', 'search_documents_ad', 'search_documents_au')`.execute(db);
  const found = new Map(rows.map((row) => [row.name, row]));
  const gaps: { name: string; problem: 'missing' | 'not-fts5' | 'other-definition' }[] = [];
  for (const name of ['search_documents', 'search_rebuilds']) if (found.get(name)?.type !== 'table') gaps.push({ name, problem: 'missing' });
  if (found.get('search_documents')?.type === 'table') {
    // The unique index of the upserts: unique, whole (no where clause) and over exactly (index_name, key), in this order, each
    // compared as written (a nocase collation would let "Slug" and "slug" share one document).
    const { rows: unique } = await sql<{ unique: number; partial: number; columns: string | null }>`select l."unique" as "unique", l.partial as partial,
        (select group_concat(name || ' ' || coll, ',') from (select name, coll from pragma_index_xinfo(l.name) where key = 1 order by seqno)) as columns
      from pragma_index_list('search_documents') l where l.name = ${UNIQUE_INDEX}`.execute(db);
    const [index] = unique;
    if (index === undefined) gaps.push({ name: UNIQUE_INDEX, problem: 'missing' });
    else if (Number(index.unique) !== 1 || Number(index.partial) !== 0 || index.columns !== 'index_name BINARY,key BINARY') gaps.push({ name: UNIQUE_INDEX, problem: 'other-definition' });
  }
  const fts = found.get('search_documents_fts');
  if (fts?.type !== 'table') gaps.push({ name: 'search_documents_fts', problem: 'missing' });
  else if (!/^create\s+virtual\s+table\s.*?\busing\s+fts5\s*\(/is.test(fts.sql ?? '')) gaps.push({ name: 'search_documents_fts', problem: 'not-fts5' });
  for (const name of ['search_documents_ai', 'search_documents_ad', 'search_documents_au']) {
    const trigger = found.get(name);
    if (trigger?.type !== 'trigger' || trigger.tbl_name !== 'search_documents') gaps.push({ name, problem: 'missing' });
  }
  return gaps;
}
