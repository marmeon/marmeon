import { withCode } from '@marmeon/core/internal';
import { sql, type Connection } from '@marmeon/database';
import type { DriverHit, DriverPage, DriverQuery, SearchKey } from '../../driver.ts';
import { SearchSetupError } from '../../errors.ts';
import { configFor, configurations, FALLBACK_CONFIGURATION } from '../../languages.ts';
import { excerptSegments, postgresPrefixQuery, type FilterScalar } from '../../terms.ts';

/** How many matches the count looks at: one more than a search reaches, so `Search` can cap the total at 1000. */
const COUNT_LIMIT = 1001;
/** The name of a filter as it may become a key of the JSON a document must contain: what an index may declare. */
const FILTER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/**
 * The weights of `ts_rank_cd` for D, C, B and A: a match of weight A counts ten times one of weight D, as on SQLite. Normalization
 * 32 maps the rank into 0 to 1 (`rank / (rank + 1)`). The rank reads the document's vector and the query alone: no statistic of the
 * table, so documents of other indexes and tenants move no score.
 */
const RANK = sql`'{0.1, 0.2, 0.4, 1.0}'::float4[]`;
/** How `ts_headline` marks a match (the private-use characters 0xE000 and 0xE001, which `cleanText` keeps out of indexed text) and how much text it keeps. */
const HEADLINE_OPTIONS = sql`'StartSel=' || chr(57344) || ',StopSel=' || chr(57345) || ',MaxFragments=1,MaxWords=24,MinWords=8'`;

/**
 * The query of one configuration. Without `prefix`, `plainto_tsquery` over the tokens joined by spaces: it reads no operator at all
 * (not even `or`, which `websearch_to_tsquery` would), so every word of the term is required, as on SQLite and Meilisearch. With
 * `prefix`, `to_tsquery` over the text of `postgresPrefixQuery()`, which holds only tokens, `&` and the final `:*`: the one use of
 * `to_tsquery`, never on anything but token strings. Both bound; neither fails on any text, and a term of stop words alone gives
 * an empty query that matches nothing.
 */
function tsquery(config: string, request: DriverQuery) {
  if (request.prefix) return sql`to_tsquery(${config}::regconfig, ${postgresPrefixQuery(request.tokens)})`;
  return sql`plainto_tsquery(${config}::regconfig, ${request.tokens.join(' ')})`;
}

/**
 * The queries of a search, one per configuration that may have read a matching document: with a locale, its configuration and the
 * fallback (documents without a locale); without one, every configuration the language map gives. A document is only tried with
 * the query of the configuration it was written with, so every branch can use the GIN index of `vector`.
 */
function queries(request: DriverQuery, map: ReadonlyMap<string, string>) {
  const names = request.locale === undefined ? configurations(map) : [...new Set([configFor(request.locale, map), FALLBACK_CONFIGURATION])];
  return sql.join(names.map((name) => sql`(${name}::text, ${tsquery(name, request)})`));
}

/**
 * One filter value as JSON: a string, a finite number or a boolean, else a `TypeError`. `JSON.stringify` would drop a key whose
 * value is `undefined` or a function, and an empty object is contained in every document, so a missing tenant would match every
 * tenant: the value is checked here, whatever checked it before.
 */
function filterScalar(value: unknown, name: string): FilterScalar {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new TypeError(`The search filter "${name}" must be a string, a finite number or a boolean, or a non-empty list of them.`);
}

/** The conditions every search shares besides the match: the indexes, the locale and the filters. */
function conditions(request: DriverQuery, map: ReadonlyMap<string, string>) {
  const filters: unknown = request.filters;
  // Only own enumerable string keys are read: a filter held anywhere else would drop out of the search, so anything else is refused.
  const prototype: unknown = typeof filters === 'object' && filters !== null ? Object.getPrototypeOf(filters) : undefined;
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(filters as object).length !== Object.keys(filters as object).length) {
    throw new TypeError('The search filters must be a plain object with enumerable string keys.');
  }
  const parts = [sql`d.index_name = any(${request.indexes.map((index) => index.name)}::text[])`];
  if (request.locale !== undefined) {
    // A document of the locale written with its current configuration, or a document without a locale (always the fallback).
    parts.push(sql`((d.locale = ${request.locale} and d.config = ${configFor(request.locale, map)}) or d.locale is null)`);
  }
  const scalars: Record<string, FilterScalar> = {};
  for (const [name, value] of Object.entries(request.filters)) {
    if (!FILTER_NAME.test(name)) throw new TypeError(`The search filter ${JSON.stringify(name)} is no declared filter name.`);
    if (Array.isArray(value)) {
      if (value.length === 0) throw new TypeError(`The search filter "${name}" got an empty list, which would match nothing.`);
      // Array.from hands a hole to the check as undefined. JSON containment compares with the type: true does not contain 1, and
      // "1" does not contain 1.
      const each = Array.from(value as readonly unknown[], (one) => sql`d.filters @> ${JSON.stringify({ [name]: filterScalar(one, name) })}::jsonb`);
      parts.push(sql`(${sql.join(each, sql` or `)})`);
    } else {
      scalars[name] = filterScalar(value, name);
    }
  }
  // A document that lacks a filter does not contain it, so it matches no value.
  if (Object.keys(scalars).length > 0) parts.push(sql`d.filters @> ${JSON.stringify(scalars)}::jsonb`);
  return sql.join(parts, sql` and `);
}

/** The documents that match, each with the query of its configuration: the part the page and the count share. */
function matches(request: DriverQuery, map: ReadonlyMap<string, string>) {
  return sql`search_documents d join (values ${queries(request, map)}) as q (config, query) on d.config = q.config
    where d.vector @@ q.query and ${conditions(request, map)}`;
}

interface Row {
  readonly index_name: string;
  readonly key: string;
  readonly score: number;
  readonly excerpt?: string | null;
}

/**
 * The text search configurations a statement can name without a schema, read once per driver: a configuration the language map
 * gives that is not among them stops the first search or write (Q9), with its name.
 */
export async function checkConfigurations(db: Connection<any>, map: ReadonlyMap<string, string>): Promise<void> {
  const { rows } = await sql<{ name: string }>`select cfgname::text as name from pg_ts_config where pg_ts_config_is_visible(oid)`.execute(db);
  const known = new Set(rows.map((row) => row.name));
  const missing = configurations(map).filter((name) => !known.has(name));
  if (missing.length > 0) {
    throw new SearchSetupError(
      withCode(
        'Q9',
        `The search languages map to the text search configuration${missing.length === 1 ? '' : 's'} ${missing.join(', ')}, which the database does not have. ` +
          'Create it in a migration, or map the language to another one in defineSearch({ languages }).',
      ),
    );
  }
}

/**
 * One search on Postgres: the documents whose vector matches the query of their configuration, in the indexes and with the locale
 * and every filter, ranked by `ts_rank_cd` (local to each document; weights 1.0, 0.4, 0.2 and 0.1 for A to D). The page is cut in a
 * CTE and `ts_headline` runs in the outer select over the page rows only, in the same statement (one snapshot: an excerpt is of the
 * very row the page holds). The count looks at no more than 1001 matches.
 */
export async function queryPgsql(db: Connection<any>, request: DriverQuery, map: ReadonlyMap<string, string>): Promise<DriverPage> {
  const headline = request.excerpts
    ? sql`, ts_headline(page.config::regconfig, d.a || E'\\n' || d.b || E'\\n' || d.c || E'\\n' || d.d, page.query, ${HEADLINE_OPTIONS}) as excerpt`
    : sql``;
  const { rows } = await sql<Row>`with page as materialized (
      select d.id, d.index_name, d.key, d.config, q.query, ts_rank_cd(${RANK}, d.vector, q.query, 32) as score
      from ${matches(request, map)}
      order by score desc, d.id desc
      limit ${request.limit} offset ${request.offset}
    )
    select page.index_name, page.key, page.score${headline}
    from page join search_documents d on d.id = page.id
    order by page.score desc, page.id desc`.execute(db);
  const hits = rows.map((row): DriverHit => ({
    index: row.index_name,
    key: JSON.parse(row.key) as SearchKey,
    score: Number(row.score),
    ...(request.excerpts ? { excerpt: excerptSegments(row.excerpt ?? '') } : {}),
  }));
  // A first page that is not full holds every match: no count needed.
  if (request.offset === 0 && hits.length < request.limit) return { hits, total: hits.length };
  const counted = await sql<{ total: string | number }>`select count(*) as total from (select 1 from ${matches(request, map)} limit ${COUNT_LIMIT}) as counted`.execute(db);
  return { hits, total: Number(counted.rows[0]?.total ?? 0) };
}
