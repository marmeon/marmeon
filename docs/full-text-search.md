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

## Searching

A search takes the indexes to look in, the words the user typed and the filters that decide what this user may see, and returns a
page of hits.

## The database driver

The `database` driver keeps every index in one table of your app's database and searches it with the text search of SQLite or
Postgres.

## Meilisearch

The `meilisearch` driver keeps each index on a Meilisearch server and talks to it through `@marmeon/fetch`, while a queued job brings
changed rows over.

## Rebuilding and flushing

A rebuild fills an index again from all of its rows, and a flush empties it.

## Checking

`marmeon check` reports an index that your search driver does not have yet.

## Testing

Your tests search through a fake that keeps its documents in memory, unless they run on the `database` driver.

## Writing a driver

A provider can bring a search driver of its own under a name that `SEARCH_DRIVER` selects; [bringing a driver](drivers.md#bringing-a-driver)
describes how a provider registers one.
