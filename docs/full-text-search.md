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
  the same locale. Any other value throws a `TypeError`.
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
is not a language tag.

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

## The database driver

The `database` driver keeps every index in one table of your app's database and searches it with the text search of SQLite or
Postgres.

## Meilisearch

The `meilisearch` driver keeps each index on a Meilisearch server and talks to it through `@marmeon/fetch`, while a queued job brings
changed rows over.

```sh title=".env"
SEARCH_DRIVER=meilisearch
SEARCH_MEILISEARCH_URL=http://meilisearch.internal:7700
SEARCH_MEILISEARCH_API_KEY=your-key
```

The driver needs Meilisearch 1.34 or later, `@marmeon/fetch` with its `HttpClient` registered, and `@marmeon/queue`. Without them,
without the address or without the key, the start stops with [Q9](errors.md#server-error-codes). The address is `http` or `https` with a host and an
optional port. A user name, a password, a query, a fragment or a path in it stops the start too. The key is printable ASCII without
line breaks, and no message names its value.

Give the app a key with only the actions it uses, not the master key. Writes and searches need `search`, `documents.add`,
`documents.delete`, `indexes.get` and `tasks.get`. A rebuild needs `indexes.create`, `settings.update`, `indexes.swap` and
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

## Checking

`marmeon check` reports an index that your search driver does not have yet.

## Testing

Your tests search through a fake that keeps its documents in memory, unless they run on the `database` driver.

## Writing a driver

A provider can bring a search driver of its own under a name that `SEARCH_DRIVER` selects; [search drivers](drivers.md#search-drivers)
describes the contract and how a provider registers one.
