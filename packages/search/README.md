# @marmeon/search

Full-text search for Marmeon apps: indexes as classes, kept current from your data, searched in the app's database (SQLite FTS5 or Postgres) or through Meilisearch, with a fake for tests.

## Installation

```sh
pnpm marmeon add search
pnpm marmeon migrate
```

Where `marmeon add` refuses, run `pnpm add -E @marmeon/search@<version of your app>`, then `marmeon discover` and `marmeon publish @marmeon/search`. The migration makes the tables of the `database` driver and the rebuild state that every driver needs.

## A first search

```ts
import { Search } from '@marmeon/search';
import { PageIndex } from './PageIndex.ts';

export class PageSearch {
  readonly #search: Search;

  constructor(search: Search) {
    this.#search = search;
  }

  async find(term: string) {
    const result = await this.#search.query({ in: PageIndex, term, filters: { audience: 'public' } });
    return result.ok ? result.value.data.map((hit) => hit.key) : [];
  }
}
```

`PageIndex` is a class that names the rows, their text fields with a weight each, and the filters a search may use.

## Documentation

- [Search](https://marmeon.com/docs/full-text-search)
- [Search: defining an index](https://marmeon.com/docs/full-text-search#defining-an-index)
- [Search drivers](https://marmeon.com/docs/drivers#search-drivers)
- [Fakes: search](https://marmeon.com/docs/fakes#search)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
