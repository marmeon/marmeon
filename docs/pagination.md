# Pagination

## Introduction

Most pages of an app are lists: people, orders, notifications, searched, sorted and paged, or loaded a bit more at a time. A list
is built from three parts. The route's **query schema** makes the URL the list's typed state, the database reads **one page**
of it, and the page links to the others.

```ts title="modules/notes/controllers/ListNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { pageQuery } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';

export const ListNotesRequest = defineRequest({
  query: r.query({
    q: r.string().trim().max(60).default(''),
    sort: r.in(['title', '-title', 'updated', '-updated']).default('-updated'),
    ...pageQuery({ perPage: [10, 25, 50] }),
  }),
});

export class ListNotesController extends Controller {
  static request = ListNotesRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof ListNotesRequest> & Authenticated) {
    // ctx.query: { q: string; sort: 'title' | '-title' | 'updated' | '-updated'; page: number; per_page: 10 | 25 | 50 }
    const { q, sort } = ctx.query;
    const direction = sort.startsWith('-') ? 'desc' : 'asc';
    let query = this.#notes.query().select(['id', 'title', 'updated_at']).where('user_id', '=', ctx.user.id);
    // `%` and `_` in q match anything here: the queries page shows how to escape them.
    if (q) query = query.where('title', 'like', `%${q}%`);
    query = sort.endsWith('title') ? query.orderBy('title', direction) : query.orderBy('updated_at', direction);
    const notes = await this.#notes.paginate(query.orderBy('id', direction), ctx.query);
    return this.view('notes/Index', { notes });
  }
}
```

The view renders `notes.data` and gives `notes.meta` to `<Pagination>`, which links the pages. `/notes?q=draft&page=2` is the
second page of the notes whose title contains "draft", and every link keeps the search and the sort.

## The URL is the state

A `GET` has no body, so a list reads what to show from its URL, typed by the request's `query` schema. `pageQuery()` brings the
fields of a paged list, to spread into the schema next to your own:

| Field | Takes | Default |
| --- | --- | --- |
| `page` | A whole number, 1 or more. | `1` |
| `per_page` | One of the sizes in `perPage`. | The first of them. |

`pageQuery({ perPage: [10, 25, 50] })` types `ctx.query.per_page` as `10 | 25 | 50`. A single number allows just that size, and
without `perPage` the size is 15. A size that is not a whole number of 1 or more throws when the schema is built.

The rules of every query schema hold here as well, and the [requests](requests.md#query-schemas) page explains them:

- **A query never answers 422.** Links outlive their pages and people type URLs, so a field the schema rejects falls back to its
  default. `?page=-1` is the first page, `?per_page=100000` the default size, and `?sort=DROP TABLE` the default order.
  `queryOptions: { onInvalid: 'redirect' }` sends such a `GET` to its clean URL instead, with a 302.
- **Every field has a default or is optional,** and its value must fit back into a URL. A field that breaks this is a compile
  error that names it.
- **A list is a repeated key.** `?tag=work&tag=home` is `['work', 'home']`. The browser writes a list the same way, so
  `reload({ data: { tag: ['work', 'home'] } })` asks for `?tag=work&tag=home`.
- **The browser never parses a URL.** The page carries the query as the server parsed it, without its defaults, and the defaults
  beside it. `<Pagination>`, `<Link query>` and `useQueryState()` build their URLs from these, and leave the defaults out:
  `?page=1` is no page's URL.

A [data table](tables.md#the-url-is-strict) is stricter on purpose: an unknown sort or filter there answers 400.

## Pages by number

`paginate(db, query, ctx.query)` reads one page of a query and counts the rows of all pages. A repository has it as
`paginate(query, ctx.query)`, on its own connection. The result is `{ data, meta }`:

| `meta` | Value |
| --- | --- |
| `page` | The page that was read. |
| `perPage` | The page size. |
| `total` | The rows of every page. |
| `lastPage` | The number of the last page, at least 1. |
| `from`, `to` | The positions of the first and last row on this page, counting from 1, or `null` when the page is empty. |

The count is a second query on the same filter, without the order and the selection. It runs first, then the page itself with
`limit` and `offset`. A page past the last one is empty, not an error. Order the query by a unique column last, as the example
above does with `id`: rows with the same title would otherwise change places between pages, and a row could show twice or not at
all.

`paginate` takes the parsed query of a schema with `pageQuery()` in it. A query without a page is a compile error that says what
to do:

```text
this query has no page — spread pageQuery() into the route's query schema: r.query({ ...pageQuery({ perPage: [25, 50] }), … }), or pass { page, perPage }
```

You can also pass `{ page, perPage }` yourself, from a job or a command. Values you write out are not checked like a query: a page
below 1 or a size that is not a whole number throws a `RangeError`. `paginationFrom()` still reads a page from search parameters,
but it is deprecated: use `pageQuery()` and the parsed query.

## Links to the pages

`<Pagination>` of `@marmeon/react` takes a page's `meta` and links the pages around the current one, with gaps in between:
`‹ Previous 1 … 4 5 [6] 7 8 … 20 Next ›`. It renders nothing when there is only one page.

| Prop | Default | Effect |
| --- | --- | --- |
| `meta` | required | The `meta` of `paginate()`. |
| `window` | `2` | How many pages to show on each side of the current one. |
| `param` | `'page'` | The query field that carries the page. |
| `labels` | English | `navigation`, `previous`, `next`, and `page(n)` for a page link's accessible name. |

Each link is the page's own URL with only the page changed: the search, the sort and the page size stay, keys the schema does not
know are dropped, and the defaults stay out. The current page is marked with `aria-current="page"`.

Its texts are English. Give it your app's words in a small component of your own:

```tsx title="layouts/Pagination.tsx"
import { Pagination as Pages, useTranslation, type PaginationProps } from '@marmeon/react';

export function Pagination(props: Omit<PaginationProps, 'labels'>) {
  const t = useTranslation('app');
  return (
    <Pages
      {...props}
      labels={{ navigation: t('pagination.navigation'), previous: t('pagination.previous'), next: t('pagination.next'), page: (page) => t('pagination.page', { page }) }}
    />
  );
}
```

On a route whose query schema has no `page` field, the links would all lead to the first page. In development and tests,
`<Pagination>` then warns once per page in the console:

```text
[marmeon:R17] <Pagination param="page"> on notes/Index, whose query schema has no "page" — its links would lead to the first page: spread pageQuery() into the route's query schema.
```

## Searching and sorting

`useQueryState()` of `@marmeon/react` turns the query into state. It returns the parsed query and a setter that visits the same
page with the new URL:

```tsx title="modules/notes/views/Index.tsx"
import type { PageProps } from '@marmeon/http';
import { Link, useQueryState } from '@marmeon/react';
import { Pagination } from '../../../layouts/Pagination.tsx';
import type { ListNotesController } from '../controllers/ListNotesController.ts';

export default function Index({ notes }: PageProps<ListNotesController>) {
  const [query, setQuery] = useQueryState('notes.index', { only: ['notes'], debounce: 300, history: 'replace' });

  return (
    <main>
      <input type="search" value={query.q} onChange={(event) => setQuery({ q: event.target.value, page: undefined })} />
      <Link route="notes.index" query={{ ...query, sort: 'title', page: 1 }} only={['notes']} preserveState preserveScroll>
        By title
      </Link>
      <ul>
        {notes.data.map((note) => (
          <li key={note.id}>{note.title}</li>
        ))}
      </ul>
      <Pagination meta={notes.meta} />
    </main>
  );
}
```

The field shows what is typed at once, and the URL follows after the pause. `page: undefined` takes the page back to its default,
so a new search starts on the first page. The state and `<Link query>` are typed by the route's schema: a sort the schema does not
have is a compile error.

| Option | Default | Effect |
| --- | --- | --- |
| `only`, `except` | every prop | The props the visit reloads. |
| `reset` | the props of `only` | Props to replace instead of merging. Another query is another list. |
| `debounce` | `0` | Milliseconds to wait after the last change before asking the server. |
| `history` | `'push'` | `'push'` adds a history entry per change, so Back undoes a sort. `'replace'` replaces the current entry, for typing, so Back leaves the list. |
| `preserveScroll` | `true` | Keeps the scroll position. |

The hook works on the page of its route only, and a route without a query schema is a compile error. Without JavaScript, put the
field in a plain `<form method="get">`: it sends the same URL. The [navigation](navigation.md#links-to-routes) page covers
`<Link>`.

## Cursors

A long list or a feed reads better with a cursor than with page numbers: there is no count and no offset, and nobody shows twice
while new rows are added. `cursorPaginate(query, options)` reads the rows after a cursor and returns the cursor of the next page:

```ts title="modules/notes/controllers/FeedController.ts"
import type { Authenticated } from '@marmeon/auth';
import { cursorPaginate } from '@marmeon/database';
import { Encrypter } from '@marmeon/encryption';
import { Controller, defineRequest, merge, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';

export const FeedRequest = defineRequest({
  query: r.query({ cursor: r.string().optional() }),
});

export class FeedController extends Controller {
  static request = FeedRequest;

  readonly #notes: NoteRepository;
  readonly #encrypter: Encrypter;

  constructor(notes: NoteRepository, encrypter: Encrypter) {
    super();
    this.#notes = notes;
    this.#encrypter = encrypter;
  }

  handle(ctx: ContextOf<typeof FeedRequest> & Authenticated) {
    const notes = merge(() =>
      cursorPaginate(this.#notes.query().select(['id', 'title', 'published_at']).where('user_id', '=', ctx.user.id), {
        column: 'published_at',
        direction: 'desc',
        cursor: ctx.query.cursor,
        perPage: 20,
        encrypter: this.#encrypter,
        name: `feed:${ctx.user.id}`,
      }),
    ).matchOn('data.id');
    return this.view('notes/Feed', { notes });
  }
}
```

The result is `{ data, meta: { perPage, nextCursor } }`. `nextCursor` is `null` on the last page.

| Option | Default | Effect |
| --- | --- | --- |
| `column` | required | The column, or a list of columns, to order by. Each must be selected by the query. |
| `key` | `'id'` | The unique column that breaks ties. It is ordered by last, and the query must select it. |
| `direction` | `'asc'` | `'asc'` or `'desc'`, for every column. |
| `cursor` | none | The `nextCursor` of the page before. Without it, the first page. |
| `perPage` | `15` | Rows per page. |
| `encrypter` | required | The app's `Encrypter`, injected. |
| `name` | none | Binds the cursors to this list. |

- **Its own order.** `{ column: 'title' }` orders by `(title, id)`, so rows with the same title keep one order. An `orderBy` the
  query had is taken out, because it would come first.
- **Empty values.** A sort column may be nullable. Rows without a value come last in both directions, on SQLite and Postgres
  alike, and the next page goes on among them instead of starting over.
- **Encrypted cursors.** A cursor is the last row's values, encrypted and signed with the app key. A visitor can neither read a
  hidden sort column's value from the URL nor make up a cursor. Each order has its own: a cursor of other columns or the other
  direction does not decrypt.
- **A name.** With `name`, a cursor of another list with the same order does not decrypt either: a table passes its name, an
  inbox its recipient, the feed above its user. Without it, such a cursor is a position in this list, and the list's own filters
  still apply.
- **A cursor that does not decrypt** answers **400** (`InvalidCursorError`): one that was changed or made up, one of another order
  or another named list, and one made with a key that has since been retired. It never quietly starts at the first page again,
  which would make "load more" repeat itself forever.

A query that does not select the key column throws a `TypeError` that says to select it, or to name another key:
`{ key: 'uuid' }`. A `perPage` that is not a whole number of 1 or more throws a `RangeError`.

## Load more

"Load more" appends the next page to what the page has. Mark the prop `merge()` on the server, as the feed above does, and ask for
the next page with the cursor in the query:

```tsx title="modules/notes/views/Feed.tsx"
import type { PageProps } from '@marmeon/http';
import { Link } from '@marmeon/react';
import type { FeedController } from '../controllers/FeedController.ts';

export default function Feed({ notes }: PageProps<FeedController>) {
  return (
    <main>
      <ul>
        {notes.data.map((note) => (
          <li key={note.id}>{note.title}</li>
        ))}
      </ul>
      {notes.meta.nextCursor && (
        <Link route="notes.feed" query={{ cursor: notes.meta.nextCursor }} only={['notes']} preserveUrl preserveScroll preserveState>
          Load more
        </Link>
      )}
    </main>
  );
}
```

A paginator merges its `data` and takes the new `meta`, and `matchOn('data.id')` keeps an item from showing twice. `preserveUrl`
keeps the list's URL in the address bar, so a reload starts at the top. Without JavaScript the link is a plain link to the next
page. The [deferred props](deferred-props.md#merged-props) page explains merging, and infinite scroll with `<WhenVisible always>`.

## Reloads replace, load more appends

Whether a reload merges depends on where it comes from, never on what it brings:

| Reload | Merged props |
| --- | --- |
| "Load more": a visit or reload with `query` or `data`, such as `<Link query={{ cursor }} only preserveUrl>` | appended |
| A revalidation: the reload after an [action](actions.md#reloading-after-an-action), a live update, a reload on Back | replaced |
| A visit with `reset: ['notes']`, such as a new sort or filter, which is another list | replaced |
| `useQueryState()` | replaced, for the props of `only` |

A revalidation brings the server's state now: a row deleted meanwhile is gone, and a list that had loaded more starts over at its
first page. One action that should append anyway says so with `router.reloading({ only: ['notes'], reset: [] })`. Live updates and
reloads on Back always replace.

## Actions on a list

Deleting, pinning or marking a row is an [action](actions.md): a request that does not leave the page. An optimistic patch shows
the change at once, and the action's reload names every prop the patch touches, so the server's answer replaces the patch when it
lands. [Ghost rows](actions.md#ghost-rows) show rows that are being added. A [live update](realtime.md) after the write reloads
the list in the user's other tabs.

For a list with columns, selection, bulk actions and a CSV export, use a [data table](tables.md). It is built from the same parts.
