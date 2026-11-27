# Search

## Introduction

`@marmeon/search` gives your app full-text search over its own data. You describe what to search as an index class, the package
keeps that index current when your rows change, and a search returns a page of hits in the order of their relevance. By default the
index lives in a table of your app's database, so search needs no other service: SQLite searches with FTS5, Postgres with its text
search. The `database` driver does not run on MySQL. When the database is not enough, or your app runs on MySQL, the same
indexes and the same searches run on a Meilisearch server instead.

## Configuration

Three environment variables configure search:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEARCH_DRIVER` | `database` | Where the index lives: `database`, `meilisearch`, or the name of a driver a provider brings. A name nobody brought stops the start with [Q9](errors.md#server-error-codes). |
| `SEARCH_MEILISEARCH_URL` | empty | The address of your Meilisearch server, such as `http://127.0.0.1:7700`. `SEARCH_DRIVER=meilisearch` needs it. |
| `SEARCH_MEILISEARCH_API_KEY` | empty | The API key the app sends to Meilisearch. `SEARCH_DRIVER=meilisearch` needs it. The log redactor masks it. |

```sh title=".env"
SEARCH_DRIVER=database
```

## Defining an index

An index is a class that says which rows to search, which of their columns hold text, how much each column weighs, and which
attributes a search may filter by.

```ts title="modules/pages/PageIndex.ts"
import type { Database, Row } from '@marmeon/database';
import { SearchIndex, type SearchDocument } from '@marmeon/search';

type PageRow = Pick<Row<'pages'>, 'id' | 'title' | 'summary' | 'body' | 'audience' | 'locale' | 'published_at'>;

export class PageIndex extends SearchIndex<PageRow> {
  static readonly index = 'pages';
  static readonly key = 'id';
  static readonly fields = { title: 'A', summary: 'B', body: 'C' } as const;
  static readonly filters = ['audience'] as const;

  source(db: Database) {
    return db.selectFrom('pages').select(['id', 'title', 'summary', 'body', 'audience', 'locale', 'published_at']);
  }

  override includes(row: PageRow): boolean {
    return row.published_at !== null;
  }

  toDocument(row: PageRow): SearchDocument<typeof PageIndex> {
    return {
      locale: row.locale,
      fields: { title: row.title, summary: row.summary, body: row.body },
      filters: { audience: row.audience },
    };
  }
}
```

The statics describe the index:

| Static | Meaning |
| --- | --- |
| `index` | The name the index is stored under: lowercase letters, digits, `_` and `-`, starting with a letter, at most 64 characters. Renaming it starts an empty index, and the documents under the old name stay until you flush them. |
| `key` | The column of the source rows that identifies a document. Its values are strings or safe integers. A name every object has, such as `constructor`, is refused. |
| `fields` | The fields a search looks in, 1 to 32, each with its weight: `A` counts most, `D` least. A field name is lowercase letters, digits and `_`, starting with a letter, at most 64 characters, and not `constructor`. |
| `filters` | Optional. The attributes a search may filter by, up to 32, named by the same rule as fields. `locale` is not one of them, because every search already narrows by locale. |
| `connection` | Optional. Only `default` is supported. |

Write `fields` and `filters` with `as const`. That keeps the names and the weights as literals, so TypeScript can check a weight
and refuse a field or a filter that the class does not declare.

`source()` returns the rows of the index as a select of the [query chain](queries.md#writing-queries). Search reads every row through
it, so a column that its migration marks [secret](migrations.md#secret-columns) never reaches the index by accident: `selectAll()`
leaves it out, and a select that names it other than with `secret()` is refused. Index a secret column only when everyone who may search may also read it.

`includes()` decides whether a row belongs in the index, such as only published pages. A row it refuses is removed from the index,
so a page that you unpublish disappears from search with the same call that indexes a change. Without `includes()`, every row of
`source()` belongs. The base class declares it as optional, so your class writes it with `override`.

`toDocument()` turns one row into what is searched: the text of each field, the value of each filter, and the locale that picks the
language rules for the text (`null` for none). With the return type `SearchDocument<typeof PageIndex>`, a field or a filter that the
class does not declare is a type error. Define `source()`, `includes()` and `toDocument()` as methods, not as properties that hold a
function. The start refuses `source()` and `toDocument()` written as properties.

A module lists its indexes in `searchIndexes`, and a package lists the indexes of its provider in `static searchIndexes`:

```ts title="modules/pages/index.ts"
import { defineModule } from '@marmeon/core';
import { PageIndex } from './PageIndex.ts';

export default defineModule({ name: 'pages', searchIndexes: [PageIndex] });
```

The container builds an index class, so its constructor can take services like any other class. The start checks every index and
stops with [Q9](errors.md#server-error-codes) when a static breaks one of the rules above, when `source()` or `toDocument()` is no
method, when `includes` is set but is no method, when two classes share a name, or when `searchIndexes` is not a list of classes. Whether the key column exists shows only
when search reads rows. The message names the module or provider that lists it, and the class
when there is one.
Listing the same class twice, from a module and a provider for example, counts as one index.

## Keeping the index current

Your code tells search which rows changed, and the driver brings their documents into the index in step with your transaction.
Inject `Search` and call `index()` after you write a row:

```ts title="modules/pages/PagePublishing.ts"
import { Connections } from '@marmeon/database';
import { Search } from '@marmeon/search';
import { PageIndex } from './PageIndex.ts';
import { PageRepository } from './PageRepository.ts';

export class PagePublishing {
  readonly #connections: Connections;
  readonly #pages: PageRepository;
  readonly #search: Search;

  constructor(connections: Connections, pages: PageRepository, search: Search) {
    this.#connections = connections;
    this.#pages = pages;
    this.#search = search;
  }

  publish(id: number) {
    return this.#connections.transaction(async () => {
      const page = await this.#pages.update(id, { published_at: new Date() });
      if (page) await this.#search.index(PageIndex, page);
      return page;
    });
  }
}
```

| Call | What it does |
| --- | --- |
| `search.index(Index, rowsOrKeys)` | Brings the documents of these rows into the index. It takes one row or key, or a list of only rows or only keys. |
| `search.remove(Index, keys)` | Takes the documents of these keys out of the index. It takes one key or a list of keys. |

A list that mixes rows and keys throws a `TypeError`, and so does a key that is neither a safe integer nor a string of 1 to 253
characters, well-formed Unicode without the NUL character. An index class that no module or provider registers throws a
`TypeError` too. `42` and `"42"` are two keys. Pass a key with the type of its column: a key that the database finds only as the
other type throws a `TypeError`, because indexing it would leave the document of the row as it was. On a driver that writes
through the queue, the job finds the mismatch when it runs and fails the attempt instead.

`index()` reads every row again through `source()`, in batches of 500 keys, and indexes the row as `source()` returns it. A row
you pass counts only for its key, so a column that `source()` leaves out never reaches the index. A key whose row is gone, or whose
row `includes()` refuses, is removed from the index. `includes()` keeps a row only when it returns exactly `true`. Search reads
`includes` from the instance that the container builds, and an `includes` there that is no method stops the call with
[Q9](errors.md#server-error-codes).

Search checks every document that `toDocument()` returns before it reaches the driver:

- A field, a filter or a property other than `locale`, `fields` and `filters` that the class does not declare throws a
  `TypeError`. A field holds a string or `null`.
- A filter value is a string of at most 255 characters without the NUL character, a finite number or a boolean. Any other value,
  `null` and a string that is no well-formed Unicode included, throws a `TypeError`. A filter that the document leaves out matches no filter on that name.
- The locale is `null` or a language tag such as `en` or `pt-BR`. It is stored in its canonical form, so `pt-br` and `pt-BR` are
  the same locale. Any other value throws a `TypeError`, and so does a tag that is longer than 35 characters in its canonical form.
- The texts lose the NUL character and the two characters of the Unicode private use area that mark the matches in excerpts.
- A document keeps at most 200 000 characters of text. The fields fill that budget in the order of their weights, `A` first, and
  in the order of `fields` within one weight. The field that reaches the limit is cut, and the fields after it are left out.

The driver decides how a change reaches its index:

| Driver writes | Drivers | What happens |
| --- | --- | --- |
| In the transaction | `database` | The documents are written inside your [transaction](transactions.md). Outside one, each batch is written in a transaction of its own. |
| Through the queue | `meilisearch` | Search queues the job `marmeon.search.sync` with the name of the index and the keys, never the text. Inside a transaction the job is held for the commit, like [any dispatch](queues.md#inside-a-transaction). |
| After the commit | the fake in tests | Search reads the documents at the call and hands them to the driver once the transaction has committed. |

In every mode, a rollback leaves nothing in the index. A driver that writes through the queue needs `@marmeon/queue`, and without it
the start stops with [Q9](errors.md#server-error-codes). The job reads its rows when it runs and writes the state they have then, so of
two jobs of one row that run one after the other, the later one wins even when it was queued first. After it wrote, the job reads its
rows again and writes once more while they changed, up to three writes. So when two jobs of one row run at the same moment, the job
whose write lands last finds the newest state and writes it. A row that changes again after each of the three writes fails the attempt.
The job also stops, and the attempt fails, when another write would outlast its 60-second timeout; the next attempt reads the rows again.
The job compares the documents of both reads, so `toDocument()` must return the same document for the same row: a document that
holds the current time, for example, makes every attempt fail.
An error of the driver fails the attempt, and
the job tries again, up to five attempts in all. A row whose document breaks one of the checks above is removed from the index by
the job, the other rows of its batch are written, and the attempt fails with the keys of the rows that broke. A key of the other
type whose row still exists fails the attempt the same way, and that row's document is removed too. A job whose index no class declares any more fails for good, and stays in the failed jobs.

With a driver that writes through the queue, `remove()` queues the same job. That job reads the row when it runs, so a row that
still exists and that `includes()` keeps comes back. Call `remove()` after you delete a row. After the row is deleted, a key of the other type, `"42"` for the key `42`, removes nothing,
and the document of the row stays in the index. To take a row out that stays, let
`includes()` refuse it and call `index()`.

## Searching

A search takes the indexes to look in, the words the user typed and the filters that decide what this user may see, and returns a
page of hits.

```ts title="modules/pages/controllers/SearchPagesController.ts"
import { Controller, defineRequest, everyone, type ContextOf } from '@marmeon/http';
import { Search } from '@marmeon/search';
import { rules as r } from '@marmeon/validation';
import { PageIndex } from '../PageIndex.ts';

export const SearchPagesRequest = defineRequest({
  authorize: everyone,
  query: r.query({ q: r.string().trim().max(100).default(''), page: r.integer().min(1).max(50).default(1) }),
});

export class SearchPagesController extends Controller {
  static request = SearchPagesRequest;

  readonly #search: Search;

  constructor(search: Search) {
    super();
    this.#search = search;
  }

  async handle(ctx: ContextOf<typeof SearchPagesRequest>) {
    const result = await this.#search.query({
      in: PageIndex,
      term: ctx.query.q,
      filters: { audience: 'public' },
      excerpts: true,
      page: ctx.query.page,
    });
    if (!result.ok) return this.view('pages/Search', { hits: [], unavailable: true });
    return this.view('pages/Search', { hits: result.value.data, meta: result.value.meta, unavailable: false });
  }
}
```

A search takes these options:

| Option | Meaning |
| --- | --- |
| `in` | The index class, or a list of index classes, to search. An empty list throws a `TypeError`. |
| `term` | What the user typed. |
| `filters` | Optional. The values a document must carry, by filter name. A list of values means any one of them. |
| `locale` | Optional. Narrows the search to documents of this locale and documents without one. |
| `prefix` | Optional. With `true`, the last word also matches the start of a word, for a search as you type. Default `false`. |
| `excerpts` | Optional. With `true`, each hit carries an excerpt of its text with the matches marked. Default `false`. |
| `page` | Optional. The page, from 1. Default 1. |
| `perPage` | Optional. Hits per page, from 1 to 100. Default 20. |

The term is only ever words. Search reads at most 256 characters of it and searches at most 16 words of letters and numbers.
Quotes, operators and field names that the user types are not syntax, so no input raises an error. A term without any word finds
nothing, and the driver is not asked.

An option that is not in this table throws a `TypeError`, so a misspelt `filter` never runs the search without its filters.

A search reaches at most the first 1000 hits. A `page` and `perPage` whose product is larger than 1000 throw a `TypeError`, and
`meta.total` counts at most 1000. A `page` or a `perPage` outside its range throws a `TypeError` as well, and so does a locale that
is not a language tag or is longer than 35 characters in its canonical form.

`query()` returns a [`Result`](errors.md#results). Its value is a page in the shape `paginate()` returns: the hits in `data`, and
where the page stands in `meta` (`page`, `perPage`, `total`, `lastPage`, `from`, `to`). Its error is a `SearchFailure` with a
`kind` and a `message`:

| `kind` | When |
| --- | --- |
| `unavailable` | The search service cannot be reached. |
| `missing-index` | An index that the search names does not exist in the search service yet. |

A hit names its index, the key of its row and its score; a higher score is a better hit. With several indexes, the type of a hit is
a union by index, so `hit.index === 'pages'` narrows `hit.key` to the key type of `PageIndex`. A hit of an index that the search
did not name never reaches you.

An excerpt is a list of segments, never HTML. Each segment has its `text` and `match`, which is `true` for the words that matched.
An excerpt is made only from the declared fields. Render it as text and mark the matches yourself:

```tsx title="views/pages/Excerpt.tsx"
import type { ExcerptSegment } from '@marmeon/search';

export function Excerpt({ segments }: { segments: readonly ExcerptSegment[] }) {
  return <p>{segments.map((segment, i) => (segment.match ? <mark key={i}>{segment.text}</mark> : <span key={i}>{segment.text}</span>))}</p>;
}
```

A hit carries the key and nothing else of its row. Load the records through your own queries, which keep their scopes and their
authorisation, and put them in the order of the hits:

```ts
const keys = result.value.data.map((hit) => hit.key);
const rows = keys.length ? await this.#pages.query().select(['id', 'title', 'slug']).where('id', 'in', keys).execute() : [];
const byId = new Map(rows.map((row) => [row.id, row]));
const pages = keys.flatMap((key) => byId.get(key) ?? []);
```

### What a search may show

What is in an index may be seen by whoever may ask the search. Search does not know your policies, so the visibility of a document
belongs in its filters, not in a check after the search: a check after the search leaves the count, the pages and the excerpts
wrong, and an excerpt shows text before any check runs. Give each document the values that decide who may see it, such as a tenant
or an audience, and pass the user's values in every search:

```ts
// In PageIndex: static readonly filters = ['tenant', 'audience'] as const;
// and in toDocument(): filters: { tenant: row.tenant_id, audience: row.audience }

await this.#search.query({ in: PageIndex, term, filters: { tenant: ctx.user.tenantId, audience: ['public', ctx.user.role] } });
```

Search refuses a filter that would quietly widen a search:

- A filter that an index does not declare is a type error, and throws a `TypeError`. With several indexes, a filter must be declared
  by every one of them.
- A filter of `undefined` or `null` throws a `TypeError`. It never means "no filter", so a user without a tenant never sees every
  tenant. Leave the filter out to search without it.
- An empty list throws a `TypeError`, because no document carries one of no values, and so does a list with a hole.
- `filters` is a plain object whose filters are its own properties. An instance of a class, an object with an inherited, hidden or
  symbol key throws a `TypeError`, because a filter that could not be read would quietly drop out of the search.
- A document that leaves a filter out matches no search that filters on it.

The score of a hit depends only on the document itself and the term. On every built-in driver, the documents that the filters
hide move neither the scores nor the order of the hits a user sees.
The time a search takes still grows with the documents that match its words, those of other tenants included. Tenants that must
not learn anything about each other belong in separate databases.

## The database driver

The `database` driver keeps every index in one table of your app's database and searches it with the text search of SQLite or
Postgres.

The table comes with the package as a migration. Publish it into your app and run it:

```sh
pnpm marmeon publish @marmeon/search
pnpm marmeon migrate
```

Once you have published it, `marmeon check` reports a migration that a newer version of the package ships and your app lacks, as
it does for [every package that ships migrations](migrations.md#publishing-the-migrations-of-a-package).

The migration makes two tables on the default connection. `search_documents` holds one row per document: the name of its index,
its key, its locale, on Postgres the text search configuration that read it, its filters and the text of its fields in the columns
`a` to `d`, one column per weight. `search_rebuilds` holds the
state of a running rebuild, on every driver: publish and run the migration for Meilisearch too. The text columns are [secret](migrations.md#secret-columns), so `selectAll()`, `marmeon db:query` and the
database MCP never show indexed text. What the schema builder cannot write is part of the migration as raw SQL, and `migrate` does
not name those objects as unknown.

The driver writes in your transaction: a document is stored or removed with the statements of your own change, and a rollback
takes it back with them. `/up/ready` stays red until `search_documents` has every column the driver uses and its text columns are
secret ([package tables](package-tables.md#tables)). An error of the database, such as a table that was not migrated yet, throws from `search.query()` like any
other query of your app; the `unavailable` failure is for search services outside your database. The driver has no SQL for MySQL: on a MySQL connection the start stops with
[Q9](errors.md#server-error-codes). Select `SEARCH_DRIVER=meilisearch` there.

### SQLite

On SQLite the driver searches with FTS5, the full-text search built into SQLite. The migration makes an FTS5 table
`search_documents_fts` over the four text columns, and triggers keep it in step with `search_documents` on every insert, update and
delete.

- **Words.** The text is split into words of letters and numbers (the `unicode61` tokenizer). Case does not count, and neither do
  diacritics: `see` finds "Sée", and `hauser` finds "Häuser".
- **Prefixes.** With `prefix: true`, the last word of the term also matches the start of a word: `hau` finds "Häuser".
- **No stemming.** SQLite compares whole words, so `house` does not find "houses". Use Postgres in production when your users
  search in a language with many word forms.
- **Ranking.** A hit's score counts, for each weight, how many words of the term occur in the fields of that weight. A word in a
  field of weight `A` counts ten times one of weight `D`, `B` four times and `C` twice. A word that occurs several times in the
  fields of one weight counts once for that weight.
- **Locales.** SQLite searches every locale with the same rules. The locale only narrows a search to the documents of that locale
  and those without one.
- **Filters.** A filter value is compared with its type: the filter `true` does not match a document that carries `1`, and `"1"`
  does not match `1`.

`marmeon db:query` and the database MCP cannot read the FTS5 table or its shadow tables, like
[any virtual table that raw SQL made](database.md#querying-a-connection).

### Postgres

On Postgres the driver searches with the text search built into Postgres, and needs no extension. The migration adds a column
`vector` of the type `tsvector` to `search_documents`, with a GIN index, and a GIN index on the filters. When the driver stores a
document, it reads the text of each weight with the text search configuration of the document's locale (see
[Languages](#languages)) and writes the words, reduced to their stems, into `vector`, each marked with its weight.

- **Words and stems.** A search finds the forms of a word that the configuration reduces to the same stem: in a German
  document, `Haus` finds "Häuser", and in an English one, `house` finds "houses". Case does not count. Diacritics do count unless the
  stemmer of the language folds them: in a document without a locale, `see` does not find "Sée".
- **Every word counts.** A hit holds every word of the term. The term carries no syntax: quotes, a leading `-` and `or` are not
  operators, so `"cat dog"`, `cat -dog` and `cat dog` find the same documents. A stop word of the document's language, such as
  "the" or "or" in English, drops out of the term: in English documents, `cat or dog` finds those with both other words, and a term
  of stop words alone finds nothing. `simple`, which reads documents without a locale (see [Languages](#languages)), has no stop
  words, so there "or" and "the" are words a document must hold.
- **Prefixes.** With `prefix: true`, the last word of the term also matches the start of a word: `häu` finds "Häuser". Use it for
  search as you type.
- **Ranking.** A hit's score comes from `ts_rank_cd`, which reads the document and the term alone: how often and how close
  together the words of the term occur, each occurrence weighed by its field, `A` ten times `D`, `B` four times and `C` twice. The
  score lies between 0 and 1.
- **Excerpts.** `ts_headline` makes the excerpt of a hit from the text of its declared fields. It runs only for the hits of the
  page, after the page is cut, so asking for excerpts costs no more for a search that matches many documents.
- **Filters.** A filter value is compared with its type, as on SQLite: the filter `true` does not match a document that carries
  `1`, and `"1"` does not match `1`.
- **No typo tolerance.** Postgres finds a word only as it is written, or one of its forms. `hosue` does not find "house". If your
  users need search that forgives typos, Meilisearch does that better.

Like the text columns, `vector` is a column the migration makes with raw SQL, and `marmeon db:query` and the database MCP treat it as
secret.

### Languages

Postgres reads the text of a document with a text search configuration, which knows the stems and the stop words of one language.
The driver picks it by the document's locale, and searches each document with the configuration that wrote it. A search with a
`locale` finds the documents of that locale and those without one; a search without one finds the documents of every locale.

These languages, by their two-letter code, use a configuration every Postgres has:

| Code | Configuration | Code | Configuration |
| --- | --- | --- | --- |
| `da` | `danish` | `nl` | `dutch` |
| `de` | `german` | `no`, `nb`, `nn` | `norwegian` |
| `en` | `english` | `pt` | `portuguese` |
| `es` | `spanish` | `ro` | `romanian` |
| `fi` | `finnish` | `ru` | `russian` |
| `fr` | `french` | `sv` | `swedish` |
| `hu` | `hungarian` | `tr` | `turkish` |
| `it` | `italian` | | |

The driver looks a locale up as it is, then by its language: `de-AT` reads with `german`. A locale it finds in neither way, and a
document without a locale, are read with `simple`, which lowercases words and neither stems them nor drops stop words.

Map locales of your own with `defineSearch()`, a configuration you list in the app's `config`:

```ts title="config/search.ts"
import { defineSearch } from '@marmeon/search';

export const AppSearch = defineSearch({
  languages: { 'de-CH': 'german', ga: 'irish' },
});
```

List it in `bootstrap/app.ts`, beside the app's other configuration: `config: [AppConfig, AppSearch]`. An app has one
`defineSearch()`. Your entries come before the built-in ones, and an entry for a whole locale such as `de-CH` comes before the one for
its language. A locale that is no language tag, or a name that is not one of a configuration (lowercase letters, digits and
underscores, without a schema), stops the start with [Q9](errors.md#server-error-codes). So do a second `defineSearch()`, whatever
the driver, an option other than `languages`, options or a `languages` value that are no plain object, and one locale spelled twice. Recent versions of Postgres bring
more configurations than the table names, such as `irish` above or `greek`, and a configuration of your own must exist in the
database before it is used; create it in a migration. The driver asks the database for the
configurations once, at the first search or write, and stops it with Q9 naming each configuration the database lacks. SQLite and
Meilisearch do not read the map.

A document keeps the configuration it was written with, in the column `config`. After you change the map,
[rebuild the index](#rebuilding-and-flushing) so that every document reads with its new configuration. Until then, a search with a
`locale` does not find a document of that locale that was written with another configuration than the one the map now gives, and
no search finds a document whose configuration the map no longer gives for any locale.

## Meilisearch

The `meilisearch` driver keeps each index on a Meilisearch server and talks to it through `@marmeon/fetch`, while a queued job brings
changed rows over.

```sh title=".env"
SEARCH_DRIVER=meilisearch
SEARCH_MEILISEARCH_URL=http://meilisearch.internal:7700
SEARCH_MEILISEARCH_API_KEY=your-key
```

The driver needs Meilisearch 1.34 or later, `@marmeon/fetch` with its `HttpClient` registered, and `@marmeon/queue`. Without them,
without the address or without the key, the start stops with [Q9](errors.md#server-error-codes). It also needs the table
`search_rebuilds` from the [migration of the package](#the-database-driver), which the job reads, and `/up/ready` stays red until it
exists. The address is `http` or `https` with a host and an
optional port. A user name, a password, a query, a fragment or a path in it stops the start too. The key is printable ASCII without
line breaks, and no message names its value.

Give the app a key with only the actions it uses, not the master key. Writes and searches need `search`, `documents.add`,
`documents.delete`, `indexes.get` and `tasks.get`. `marmeon check` needs `version` and `settings.get` in addition. A rebuild needs `indexes.create`, `settings.update`, `indexes.swap` and
`indexes.delete` in addition. Meilisearch answers a missing action like a wrong key, so the driver's warning names both.

Your Meilisearch server usually has a private address, which the [HTTP client](http-client.md#reaching-your-own-network) refuses.
The driver allows that address for itself, under three rules:

- It allows only the addresses that the host of `SEARCH_MEILISEARCH_URL` resolves to, resolved again for every request.
- It allows them only for its own requests to that host. Every other request of your app, and `FETCH_ALLOWED_ADDRESSES`, stay as
  they are.
- It follows no redirect. A redirect fails the request, so the key never reaches another address.

Changes reach Meilisearch through the job `marmeon.search.sync`, so a [worker](queues.md#running-workers) must run. The job waits up to 8 seconds
for Meilisearch to apply each write. A write that Meilisearch rejects, or that it has not applied by then, fails the attempt, and the
job tries again. A write first checks that its index exists, so it does
not create one. Only an index that is deleted while a write runs can come back with the default settings of Meilisearch. Create each index, with
its settings, with `marmeon search:rebuild <index>` (see [Rebuilding and flushing](#rebuilding-and-flushing)). Until then, a job of
that index fails with that command in its message, and a search returns the `missing-index` failure.

The driver stores each filter value as a hash, so filters compare exactly: Meilisearch alone would treat `Alice` and `alice`, or
`7` and `"7"`, as one value. The `f_` attributes in Meilisearch therefore hold hashes. A field is stored as
`s_<field>`, and a document's id is a hash of its key.

A search sends only the words of the term, so no quote or `-` that a user types is search syntax. Every word must match. Meilisearch
always matches the last word as the start of a word too, so `prefix: false` changes nothing on this driver. Every other failure
returns the `unavailable` failure: an outage, a host that does not resolve, a timeout, an answer of 5xx, a refused key, a search that
Meilisearch rejects and an answer it cannot read. A refused key and a rejected search also log a warning.

Meilisearch picks the words that a typo or a prefix may stand for from the whole index, and it stops after a limited number of
them. So which documents a search finds, and their order, can depend on other documents of the index, those that a filter leaves
out included. Tenants that must learn nothing about each other need separate indexes, or the `database` driver on Postgres.

## Rebuilding and flushing

A rebuild fills an index again from all of its rows, and a flush empties it.

```sh
pnpm marmeon search:rebuild pages
pnpm marmeon search:rebuild
pnpm marmeon search:flush old_pages
```

Run `search:rebuild` after you deploy a new index, after you change the fields, the filters or the language map of an index, and
whenever a change may have bypassed `search.index()`, such as an update in a migration or by hand. Without a name, it rebuilds every
registered index, one after another. A name that no index has stops it with the list of the known names.

The rebuild reads the rows through `source()`, in the order of the key, 500 at a time. `--batch` sets another size, from 1 to 500.
Each row goes through `includes()` and `toDocument()` as with `search.index()`, so a row that does not belong loses its document. The
rebuild prints one line per batch with the documents written and removed so far, and at the end the totals and the time it took.
It prints no text of a document. A row that `toDocument()` cannot turn into a document stops the rebuild with exit code 1 and the
error, and the next run goes on from there.

A rebuild keeps its state in the table `search_rebuilds`, so it needs the [migration of the package](#the-database-driver) on every
driver, Meilisearch included. After each batch, it saves the last key as a checkpoint. A run that stops, because it failed or because
you ended it, leaves the checkpoint behind. The next run of that index goes on after the checkpoint and says so. `--fresh` discards
the checkpoint and starts from the first row.

A run that goes on keeps the batches it wrote. When the fields, the filters, the key or the language map changed since the run
started, the next run starts over by itself and says why. A change to the code of the index class, such as `includes()` or
`toDocument()`, and a change to rows behind the back of search are invisible to that check: run `search:rebuild --fresh` after
them.

One run at a time rebuilds an index. A run holds a lock on it, renews it after each batch and releases it at the end. A second run
of the same index exits with code 1 and says until when the lock holds. A run that stops without releasing its lock frees the index
60 seconds after its last batch. When another run took the lock over in the meantime, the first run stops with exit code 1 at its
next batch, and the other one goes on from the last saved batch. Without a name, a held index does not stop the rebuild of the
others, but the command still exits with code 1.

On the `database` driver, a batch and its checkpoint are written in one transaction. After the rows, the rebuild sweeps the stored
documents of the index and removes each one whose row is gone or no longer belongs. A document that your app writes again while
the sweep runs stays. Only the `database` driver is swept: on a driver that a provider brings without `swap()`, a rebuild leaves the
documents of deleted rows in place, so flush such an index before you rebuild it.

On Meilisearch, the rebuild fills a new index of its own, such as `pages__rebuild_0a1b2c3d` (the index name and the first 8
characters of the run's id), and swaps it in at the end. Until then, searches read the old index. First, the rebuild creates both
indexes when they do not exist yet and applies the settings of the class to both. While the rebuild runs, the job
`marmeon.search.sync` writes each change to both indexes, so the swap loses no change. After each batch, the rebuild reads its rows
again and writes them again while they changed, as the job does. A batch whose rows change at each of three writes stops the rebuild
with exit code 1, and the next run goes on from that batch. The swap also removes the documents of rows that were gone before the
rebuild read their batch. A run that goes on keeps its index. A run that starts over, with `--fresh`, under another definition or
after a run that stopped during its swap, deletes the index of the earlier run first.

The rebuild is the only command that creates an index on Meilisearch and applies its settings. A write of your app checks first that
its index exists. A job that writes to the new index of a rebuild in the moment the swap deletes it can still create it again, with
the default settings of Meilisearch; delete such a leftover `__rebuild_` index by hand. A driver that a provider brings
[decides](drivers.md#search-drivers) whether it fills an index of its own.

`search:flush <index>` removes every document of an index. It also takes a name that no class declares any more, such as the old
name of a renamed index, whose documents stay until you flush them. It discards an unfinished rebuild of the index first, so that no
later run brings the flushed documents back. It holds the lock of the index while it empties it, so no rebuild starts meanwhile, and it
exits with code 1 while a rebuild of the index holds the lock. Where your app is
protected, as in production, it asks for `--force`, as the [database commands](migrations.md#where-the-app-is-protected) do.

## Checking

`marmeon check` reports what your search driver lacks, or has in another form than your app needs.

```sh
pnpm marmeon check --only=search-indexes
```

The check `search-indexes` asks the driver what it lacks. Each finding is an error with the code [Q9](errors.md#server-error-codes),
and it names a command where one fixes it. A driver without `inspect()` has nothing to report, so the check passes.

On the `database` driver, the check reads the catalog of the default connection. It finds each of these that is missing:

- The tables `search_documents` and `search_rebuilds`. The fix is `marmeon publish @marmeon/search && marmeon migrate`.
- On SQLite, the FTS5 table `search_documents_fts` and its three triggers `search_documents_ai`, `search_documents_ad` and
  `search_documents_au`.
- On Postgres, the column `vector` of type `tsvector` and the GIN indexes `search_documents_vector_index` and
  `search_documents_filters_index`. An index that a failed build left invalid counts as different. Postgres looks each name up through the search path, as the driver's queries do.
- On Postgres, a text search configuration that your [language map](#languages) gives and the database does not have.

The migration of the package creates all of them. An object that is missing or different while its table exists was changed after
that migration ran, so the finding asks you to create it again in a migration of your own. When the migration is published but has
not run yet, the database refuses every query with [D2](errors.md#server-error-codes). The check is then `error` with that message,
and `marmeon migrate` fixes it.

On the `meilisearch` driver, the check asks the server, and it only reads. It finds:

- A server older than 1.34, or one whose version it cannot read.
- An index that does not exist on the server, with the fix `marmeon search:rebuild <index>`.
- An index whose searchable attributes, filterable attributes or `maxTotalHits` differ from what its class gives. The order of the
  searchable attributes counts, since it is the order of the weights. The fix is `marmeon search:rebuild <index>`.
- A missing table `search_rebuilds`, which the job reads for every change.
- An index named `<index>__rebuild_` followed by eight hex digits that no row of `search_rebuilds` names. A rebuild left it behind that
  finished, started over or was flushed without deleting it. Delete it in the Meilisearch dashboard or with `DELETE /indexes/<name>`. A
  rebuild that ends while the check runs can show up once, so run the check again before you delete one.
  A stopped rebuild keeps its row until it resumes, so its target is not reported.

A server that the check cannot reach, or that refuses the key, is one finding that names the host and never the key. The check asks
nothing more after it. The key needs the actions `version`, `indexes.get` and `settings.get` for the check.

## Testing

Your tests search through a fake that keeps its documents in memory, unless they run on the `database` driver.

`createTestApp()` replaces the search driver with the fake as soon as your app has `@marmeon/search`, except when the app selects
`SEARCH_DRIVER=database`, the default. That driver searches the test database, which your test has already, so the test runs on the
real text search. Pass `search: 'fake'` to put the fake in place on every driver, and `search: 'real'` to keep the configured one.

The fake keeps `Search` in front of it, so your index classes read their rows and build their documents as in production.
`app.search.assertIndexed(PageIndex, page.id)` asserts what reached the index. [Fakes](fakes.md#search) lists every assertion and
how the fake searches.

## Writing a driver

A provider can bring a search driver of its own under a name that `SEARCH_DRIVER` selects; [search drivers](drivers.md#search-drivers)
describes the contract and how a provider registers one.
