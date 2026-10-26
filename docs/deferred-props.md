# Deferred Props & Islands

## Introduction

A page does not have to wait for its slowest data. A controller can mark a prop with `defer()`, and the page renders without it
while the prop follows right after:

```ts title="modules/notes/controllers/ShowNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, defer, optional, type HttpContext } from '@marmeon/http';
import { NoteHistory } from '../NoteHistory.ts';

export class ShowNoteController extends Controller {
  readonly #history: NoteHistory;

  constructor(history: NoteHistory) {
    super();
    this.#history = history;
  }

  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    const { note } = ctx.params;
    return this.view('notes/Show', {
      note,
      revisions: defer(() => this.#history.revisions(note.id)),
      backlinks: defer(() => this.#history.backlinks(note.id), 'sidebar'),
      stats: optional(() => this.#history.stats(note.id)),
    });
  }
}
```

```tsx title="modules/notes/views/Show.tsx"
import type { PageProps } from '@marmeon/http';
import { Deferred, Head, WhenVisible } from '@marmeon/react';
import type { ShowNoteController } from '../controllers/ShowNoteController.ts';

export default function Show({ note, revisions, stats }: PageProps<ShowNoteController>) {
  return (
    <main>
      <Head title={note.title} />
      <h1>{note.title}</h1>
      <Deferred<ShowNoteController> data="revisions" fallback={<p aria-busy="true">Loading the history…</p>}>
        {() => <ul>{revisions!.map((revision) => <li key={revision.id}>{revision.summary}</li>)}</ul>}
      </Deferred>
      <WhenVisible<ShowNoteController> data="stats" fallback={<p aria-busy="true">…</p>}>
        {() => <p>{stats!.words} words, read {stats!.reads} times</p>}
      </WhenVisible>
    </main>
  );
}
```

This page covers props that load after the page, partial reloads and polling, props that merge into what the page has, and
islands: parts of a page with a route of their own.

## Props that load later

### Deferred props

A `defer()` prop is left out of the page's first answer. On a first visit, the server computes it after the page's first part went
out and streams it into the same response. After a visit inside the app, the browser asks for it right after the page shows.
`<Deferred data>` shows its fallback until the prop is there, also in the server's HTML:

```tsx
<Deferred<ShowNoteController> data={['revisions', 'backlinks']} fallback={<Spinner />}>
  {() => <History revisions={revisions!} backlinks={backlinks!} />}
</Deferred>
```

The children are a function, so they render only once the props are there, and may use them without checks. Deferred props of one
group come in one request, and groups load in parallel: `defer(fn, 'sidebar')` puts a prop in the group `sidebar`, and the default
group is `default`. A visit or `router.reload()` of the whole page leaves them out again, and the fallback shows until they are
back. A revalidation of the whole page, such as the reload after an action, a live update or a reload on Back, keeps the old
values on screen until the new ones land.

On a first visit, the deferred props are computed after the page's headers went out, so they only read, as islands do. The
[warning below](#how-islands-load) explains what that rules out.

### Props loaded when seen

An `optional()` prop is never part of a full answer. The page gets it only when it asks for it by name. `<WhenVisible>` asks once
its element scrolls into view:

```tsx
<WhenVisible<ShowNoteController> data="stats" buffer={200} fallback={<p aria-busy="true">…</p>}>
  {() => <Stats stats={stats!} />}
</WhenVisible>
```

`buffer` starts the request that many pixels before the element is visible. `as` names the watched element, a `div` by default.
`params` takes a whole reload instead of prop names. In a browser without `IntersectionObserver` it loads right away. A
`defer()` prop works with `<WhenVisible>` too.

### Partial reloads

A partial reload asks the server for some props of the page on screen. The server computes only those:

```tsx
const router = useRouter<ShowNoteController>();
<button type="button" onClick={() => void router.reload({ only: ['stats'] })}>Refresh</button>
```

`only` names the props to send, and `except` sends all but those. An `optional()` or `defer()` prop comes only when `only` names
it. A prop wrapped in `always()` comes with every partial reload, as the validation errors do. A plain function as a prop is
called only when the answer includes it, so a partial reload of other props never runs it. `<Link only>` and `useRouter()`'s
`visit()` take the same options, and the prop names are checked against the controller.

### Polling

`usePoll()` reloads the page in the background at an interval:

```tsx
usePoll<ShowNoteController>({ intervalMs: 15_000 }, { only: ['revisions'] });
```

The poll shows no progress bar and cancels no visit. It pauses while the tab is hidden and catches up when the tab is shown again.
It stops when the component unmounts. The first argument sets the interval as `intervalMs` and takes `keepAlive: true` to poll in a hidden tab too, and
`autoStart: false` to start later; the second is the reload options (`only`, `except` …), optional. `usePoll()` returns `{ start, stop }`.

## Merged props

A prop marked `merge()` is merged into what the page has when a partial reload brings it, instead of replacing it. That makes "load
more" a partial reload:

```ts title="modules/notes/controllers/ListNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, merge, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';

export const ListNotesRequest = defineRequest({
  query: r.query({ cursor: r.string().optional() }),
});

export class ListNotesController extends Controller {
  static request = ListNotesRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof ListNotesRequest> & Authenticated) {
    const page = await this.#notes.pageFor(ctx.user.id, ctx.query.cursor);
    return this.view('notes/Index', { notes: merge(page).matchOn('data.id') });
  }
}
```

```tsx
{notes.meta.nextCursor && (
  <Link route="notes.index" query={{ cursor: notes.meta.nextCursor }} only={['notes']} preserveUrl preserveScroll preserveState>
    Load more
  </Link>
)}
```

How a prop merges:

- **Arrays** are appended. With `matchOn('id')`, an item whose key the page has already takes the old item's place, so nothing
  shows twice. A key can be a path into the items, such as `'user.id'`.
- **Objects** are merged one level deep with `merge()`, and all the way down with `deepMerge()`.
- **A paginator**, `{ data, meta }`, appends its `data` and takes the new `meta`. Match its items with `matchOn('data.id')`.

`preserveUrl` keeps the list's URL in the address bar, so a reload starts at the top instead of showing one later page alone. For
infinite scroll, put `<WhenVisible always params={{ data: { cursor }, only: ['notes'], preserveUrl: true }} />` at the end of the
list: `always` loads again each time it comes into view. `defer(fn).merge()` merges a deferred prop the same way once it has
loaded.

Whether a reload merges depends on where it comes from:

- **"Load more"**, a visit or reload that brings `query` or `data`, appends.
- **A revalidation** replaces what it brings: the reload after an [action](actions.md#reloading-after-an-action), a live update,
  and a reload on Back. The server's answer is the state now, so a row deleted meanwhile is gone, and a list that had loaded more
  starts over at its first page. `reset: []` on the reload merges instead.
- **A visit can decide**: `reset: ['notes']` replaces the list, as a new sort or filter wants.

The [pagination](pagination.md) page shows lists with pages, cursors and query schemas.

## Islands

An island is a part of a page that is the view of another route. It has its own controller, middleware, authorization and query,
so one island can sit on several pages, and a slow or forbidden part never holds up the page.

### The island's route

An island's controller answers with `this.island()`. Its route is a `GET` route like any other:

```ts title="modules/notes/controllers/ShowRecentNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';

export const RecentNotesRequest = defineRequest({
  query: r.query({ limit: r.integer().between(1, 20).default(5) }),
});

export class ShowRecentNotesController extends Controller {
  static request = RecentNotesRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof RecentNotesRequest> & Authenticated) {
    return this.island('notes/RecentNotes', { notes: await this.#notes.recent(ctx.user.id, ctx.query.limit), now: new Date() });
  }
}
```

```ts
notes.get('/islands/recent', ShowRecentNotesController).name('recent'); // `notes` is a registrar with a decision
```

An island's route answers only an island's request. Opened directly, visited, linked or prefetched, it is a 404, and a route of
another method refuses an island's controller at compile time. An island gets no shared props: the page around it has them.

### Embedding an island

`<Island route>` renders the island where it stands:

```tsx title="modules/notes/views/Dashboard.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, Island } from '@marmeon/react';
import type { ShowDashboardController } from '../controllers/ShowDashboardController.ts';

export default function Dashboard(_props: PageProps<ShowDashboardController>) {
  const loading = <p aria-busy="true">Loading…</p>;
  return (
    <main>
      <Head title="Dashboard" />
      <Island route="notes.recent" query={{ limit: 3 }} fallback={loading} />
      <Island route="notes.activity" load="visible" pollMs={30_000} fallback={loading} unauthorized={<p>Confirm your address to see this.</p>} />
    </main>
  );
}
```

| Prop | Effect |
| --- | --- |
| `route`, `params`, `query` | The island's route, its parameters and its first query, typed by its query schema. Only an island's route is accepted. |
| `fallback` | Shown until the island is there. |
| `unauthorized` | Shown when its route turns the user away: a redirect, such as to the sign-in page, a 401 or a 403. |
| `error` | Shown when it failed. A function gets `retry`. Default: a short notice. |
| `load` | `'visible'` loads it once it scrolls into view. Default `'eager'`. |
| `buffer` | With `load="visible"`, starts that many pixels early. |
| `pollMs`, `keepAlive` | Reloads it every `pollMs` milliseconds once it is loaded, paused in a hidden tab unless `keepAlive`. |
| `as`, `className`, `id` | The element around it, a `div` by default. It carries `data-island` and `data-status`. |

### Inside an island

The island's view takes its props from the controller with `IslandProps`, and `useIsland()` reloads it:

```tsx title="modules/notes/views/RecentNotes.tsx"
import type { IslandProps } from '@marmeon/http';
import { Link, useIsland } from '@marmeon/react';
import type { ShowRecentNotesController } from '../controllers/ShowRecentNotesController.ts';

export default function RecentNotes({ notes }: IslandProps<ShowRecentNotesController>) {
  const island = useIsland<ShowRecentNotesController>();
  return (
    <>
      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            <Link route="notes.show" params={{ note: note.id }}>{note.title}</Link>
          </li>
        ))}
      </ul>
      <button type="button" disabled={island.pending} onClick={() => void island.reload({ query: { limit: island.query.limit + 5 } })}>
        More
      </button>
    </>
  );
}
```

`useIsland()` gives the island's `props`, its `query` with the defaults filled in, its `status`, `pending` while a request runs,
and the `failure` of the last reload. `reload({ query, only, except, reset })` asks again for this island only, and its `query` is
checked against the route's query schema. A link inside an island navigates the page. `<Head>` inside an island throws in
development and renders nothing in production, because the page owns the head.

### How islands load

On a first visit, the server runs each island's route while the page streams, in the same process, with its own middleware and
authorization. The island arrives in the same response, behind a boundary the page does not wait for, and the browser shows it
without a request. After a visit inside the app, the browser loads the page's islands in parallel. Two identical islands share one
request. Islands with `load="visible"` always load in the browser.

> [!WARNING]
> An island's request only reads, and so does a deferred prop streamed with the first page. Neither may write the session, set a
> cookie or queue work after the response, and neither takes a flash message: the page itself takes its flash messages as usual,
> also when its deferred props stream with it. In development and in tests such a write throws a
> `ReadOnlyError` that names the island or the streamed prop and where the write belongs. In production it is dropped and logged. An island's request is read-only wherever it runs. A deferred group
> that the browser loads later is an ordinary request of the page's route, so a deferred prop that writes works after a visit
> inside the app and loses the write on a first visit. Keep writes in the page's controller or in an action.

The island lives with the page's history entry: Back and Forward show it again from memory, and a static `revalidateOnBack` on its
view reloads it in the background, as for a page.

When an island's route redirects or answers 401 or 403, the island shows `unauthorized`, and the page never navigates. When it
fails, it shows `error`, and the rest of the page stays as it is.

## Props that follow changes elsewhere

A page, a layer or an island can follow a live channel and reload props when the server says something changed. The
[real time](realtime.md#following-a-channel) page covers it, and `useLiveUpdates()` for a page with unsaved changes.
