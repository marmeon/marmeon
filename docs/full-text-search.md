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
