# Lists: queries, pages and actions

Most pages of an app are lists: people, orders, notifications — searched, sorted, paged or loaded a bit more at a time, with
actions on their rows. This guide puts the parts together: the **query schema** that makes the URL the list's typed state, **pages
and cursors**, **merged props** for "load more", and what happens to a list when an action or a live hint reloads it. For a table
with columns, selection, bulk actions and a CSV export there is @bespokecore/table — the guide [tables](tables.md) — built on the
same parts.

## The URL is the state: query schemas

A GET has no body — its controller reads the URL, typed by the request's `query` schema (E55):

```ts
// modules/user-profile/controllers/ListPeopleController.ts
export const ListPeopleRequest = defineRequest({
  query: v.object({
    q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60)), ''),
    sort: v.optional(v.picklist(['name', '-name', 'joined', '-joined']), 'name'),
    ...pageQuery({ perPage: [10, 25, 50] }),          // ?page= and ?per_page= — @bespokecore/database
  }),
});
// handle(ctx: ContextOf<typeof ListPeopleRequest>) — ctx.query: { q: string; sort: 'name' | …; page: number; per_page: 10 | 25 | 50 }
```

- **A query never answers 422** (E56): links outlive their pages and people type URLs, so a field the schema rejects falls back to
  its default — `/people?sort=DROP TABLE` is the list by name. With `queryOptions: { onInvalid: 'redirect' }` an invalid GET is
  redirected (302) to its canonical URL instead. (A [table](tables.md#the-security-model) is stricter on purpose: 400.)
- **The schema must be total** — every field optional or with a default — and its output must fit back into a URL.
- **Lists are repeated keys:** `?role=admin&role=owner` is `['admin', 'owner']`, and the browser writes a list in a GET's `data`
  the same way — `reload({ data: { role: ['admin', 'owner'] } })` asks for `?role=admin&role=owner` (before Wave 9: one value,
  `role=admin%2Cowner`).
- **The browser never parses a URL:** the page object carries the parsed query without its defaults (`PageObject.query`) and the
  defaults (`queryDefaults`). `useQueryState` and `<Link query>` are typed by the same schema:

```tsx
const [query, setQuery] = useQueryState('user-profile.people', { only: ['people'], debounce: 300, history: 'replace' });
<input type="search" value={query.q} onChange={(event) => setQuery({ q: event.target.value, page: undefined })} />
<Link route="user-profile.people" query={{ sort: '-joined' }}>Newest first</Link>   {/* a sort the schema does not have is a compile error */}
```

The details: [query schemas](../packages/router/README.md#query-schemas-e55-e56) in the router's README.

## Pages by number

```ts
const page = await paginate(this.#db, query, ctx.query);        // or repository.paginate(query, ctx.query)
// { data, meta: { page, perPage, total, lastPage, from, to } }
```

`paginate` takes the **parsed** query of a schema with `pageQuery()` in it — a query without a page is a compile error that says
what to do ("this query has no page — spread pageQuery() into the route's query schema …"). `?page=-1` or `?per_page=100000` fall
back to their defaults like every query field. `paginationFrom(ctx.query)` still works but is deprecated.

`<Pagination meta={page.meta} />` of `@bespokecore/react` links the pages, built from the **parsed query**: the search, the sort and the
page size stay, the defaults stay out (`?page=1` is no page's URL), keys the schema does not know are not carried along. Its texts
are English; give it the page's language through `labels` from the app's own messages (E38) — best in a small wrapper, as the web
app's `layouts/Pagination.tsx`:

```tsx
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

A route whose schema has no page field gets a development warning (`[bespoke:R17]`) from `<Pagination>`.

## Cursors and "load more"

For long lists and feeds: keyset pagination — no count, no offset, nobody shown twice while rows are added.

```ts
constructor(db: Database<'blog'>, encrypter: Encrypter) { … }      // Encrypter from @bespokecore/encryption

const page = await cursorPaginate(this.#db.selectFrom('articles').select(['id', 'title', 'published_at']), {
  column: 'published_at', direction: 'desc', cursor: ctx.query.cursor, perPage: 20, encrypter: this.#encrypter,
});   // ordered by (published_at desc nulls last, id desc); page.meta.nextCursor — null on the last page
```

- **The key breaks ties** by itself (`{ column: 'name' }` orders by `(name, id)`), NULLs come last in both directions and a NULL is a
  cursor like any other — the next page goes on among them instead of starting over.
- **Cursors are encrypted** with the app key, with their own context per list (columns, direction): a client can neither read a
  hidden sort column's value from the URL nor make one up. One that does not decrypt — changed, made up, another list's, a key
  rotated away, the unencrypted format before Wave 9 — is a **400** (`InvalidCursorError`), never the first page again.

"Load more" appends the next page to what the page has. Mark the prop `merge()` on the server — a paginator's `data` is appended,
its `meta` replaced, items matched on their key — and ask for the next page with the cursor in the query:

```ts
// the controller (the web app's notifications)
const notifications = merge(async () => {
  const page = await this.#inbox.page(me, { cursor: ctx.query.cursor, perPage: 10, encrypter: this.#encrypter });
  return { data: page.data.map(present), meta: page.meta };
}).matchOn('data.id');
return this.view('notifications/Index', { notifications }).live(notificationsChannel(me), { only: ['notifications'] });
```

```tsx
// the view: the next ten, appended — the URL stays the list's (a reload starts at the top); without JavaScript a plain link
{notifications.meta.nextCursor && (
  <Link route="notifications.index" query={{ cursor: notifications.meta.nextCursor }} only={['notifications']} preserveUrl preserveScroll preserveState>
    {t('more')}
  </Link>
)}
```

`merge()` appends arrays (or a paginator's `data`), `deepMerge()` merges objects all the way down; `matchOn` takes a path into the
items (`'data.id'`, `'user.id'`) — an item with a known key takes the old one's place instead of appearing twice.

## Revalidations replace, load more appends

Whether a reload merges depends on **where it comes from**, never on what it looks like (E183):

| Reload | Merged props |
| --- | --- |
| "Load more" — a visit or reload with `data`/`query` (`<Link query={{ cursor }} only preserveUrl>`, `reload({ data: { cursor }, only })`) | **appended** |
| A revalidation — an action's reload (`router.reloading({ only })`), a live hint's, `revalidateOnBack` | **replaced** (`reset`) |
| A visit with `reset: ['people']` (a new sort or filter is another list) | replaced |

A revalidation brings the server's state *now*: a row deleted meanwhile is gone, and a list that had loaded more starts over at
its first page. Before Wave 9 a revalidation merged — the deleted row came back from the pages loaded before. One action that
should append anyway says so: `router.reloading({ only: ['notifications'], reset: [] })`; `reset: ['a']` replaces only `a`. Live
hints and `revalidateOnBack` always replace.

## Actions on a list

Actions (E59) are requests that do not navigate — typed by their route, never cached, protected against CSRF:

```tsx
const router = useRouter<ShowNotificationsController>();
const destroy = useAction('notifications.destroy');
const reload = router.reloading({ only: ['notifications', 'bell'] });

const remove = (id: string) =>
  void destroy.submit({
    params: { notification: id },
    confirm: t('confirm_delete'),
    optimistic: router.optimistic((props) => ({
      notifications: { ...props.notifications, data: props.notifications.data.filter((item) => item.id !== id) },
    })),
    reload,     // a revalidation: replaces the merged list — the deleted row never comes back from what was loaded
  });
```

- **Optimistic patches** show at once and are rolled back unless the action succeeds; `reload` brings the server's answer and
  replaces every patch when it lands — so it names every prop the patches touch. The code of the patches loads with the first
  `router.optimistic()`/`reloading()` of a page (a chunk of its own): that first patch shows a moment later, every later one at once.
- **Other tabs:** a live hint after the write (`broadcast.refresh(channel, { only })`) reloads the list there — a revalidation too,
  so it replaces ([real time](realtime.md)).
- `submit` resolves with `{ ok, kind }` and never rejects; `usePendingSubmissions(route)` gives ghost rows for adds in flight.

The details: [actions](../packages/react/README.md#actions), [merged props](../packages/http/README.md#merged-props-revalidations-replace-load-more-appends-w9),
[pagination](../packages/database/README.md#pagination).
