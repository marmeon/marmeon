# Testing Pages

## Introduction

A page test visits a route and checks which page it renders and with which props. The props are typed by the page's controller,
so a test that checks a prop the controller no longer sends stops compiling:

```ts title="modules/notes/show.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import type { ShowNoteController } from './controllers/ShowNoteController.ts';
import { NoteFactory } from './factories/NoteFactory.ts';

it('shows a note to its author', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const note = await app.factory(NoteFactory).create({ user_id: ada.id, title: 'Groceries' });
  await app
    .actingAs(ada)
    .navigating()
    .get(`/notes/${note.id}`)
    .assertOk()
    .assertPage<ShowNoteController>('notes/Show', { note: { title: 'Groceries' } });
});
```

`navigating()` sends the request as a client-side visit, so the answer is the page object as JSON. The test never renders React
unless it asks for [server rendering](#server-rendering).

## Asserting a page

`assertPage(component, props)` passes when the answer renders that page. `props` is either a part of the props, compared deeply,
or a function that receives them:

```ts title="modules/notes/index.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import type { ListNotesController } from './controllers/ListNotesController.ts';
import { NoteFactory } from './factories/NoteFactory.ts';

it('lists the notes in their order', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.factory(NoteFactory).create({ user_id: ada.id, title: 'Groceries' });
  await app.factory(NoteFactory).create({ user_id: ada.id, title: 'Recipes' });
  await app.actingAs(ada).navigating().get('/notes').assertPage<ListNotesController>('notes/Index', (props) => {
    expect(props.notes.data.map((note) => note.title)).toEqual(['Groceries', 'Recipes']);
  });
});
```

With a controller as the type argument, the component must be the view that controller renders, and the props are its props.
Without one, the component must be one of the app's views, so a misspelt name is a compile error either way.

A request without `navigating()` is a page load, and its answer is the HTML document. `assertPage()` reads the page object from
the document's page script, so it works on both. `response.page()` returns the whole page object, with its `url`, its `props`,
the deferred groups in `deferredProps` and the flash messages in `flash`.

## Deferred and optional props

A first visit leaves out deferred props and names their groups. A partial reload, as the browser sends it for a deferred group,
brings them:

```ts title="modules/notes/revisions.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import type { ShowNoteController } from './controllers/ShowNoteController.ts';
import { NoteFactory } from './factories/NoteFactory.ts';

it('loads the revisions after the page', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const note = await app.factory(NoteFactory).create({ user_id: ada.id });

  const first = await app.actingAs(ada).navigating().get(`/notes/${note.id}`).assertOk();
  expect(first.page()!.props).not.toHaveProperty('revisions');
  expect(first.page()!.deferredProps).toEqual({ default: ['revisions'], sidebar: ['backlinks'] });

  const later = await app.actingAs(ada).reloading<ShowNoteController>('notes/Show', { only: ['revisions'] }).get(`/notes/${note.id}`);
  expect(Object.keys(later.page()!.props).sort()).toEqual(['errors', 'revisions']);
});
```

`reloading<Controller>(component, { only, except })` sends a partial reload of `component`, the page on screen. `only` and
`except` are typed by the controller's props. An `optional()` prop arrives the same way, only when a partial reload names it. A
partial reload runs the route's middleware like any request, so a guest gets the redirect, not the props. The
[deferred props](deferred-props.md#props-that-load-later) page explains both kinds.

`prefetching()` sends the request as a prefetch of a link. Its answer is the page, but it takes no flash message: the message
waits for the visit that shows the page.

## Islands

`island(name, params, query)` sends the request an `<Island route>` sends, by the island route's name:

```ts title="modules/notes/recent.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import type { ShowRecentNotesController } from './controllers/ShowRecentNotesController.ts';
import { NoteFactory } from './factories/NoteFactory.ts';

it('shows the latest notes in the island', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.factory(NoteFactory).count(4).create({ user_id: ada.id });
  await app
    .actingAs(ada)
    .island('notes.recent', {}, { limit: 3 })
    .assertIsland<ShowRecentNotesController>('notes/RecentNotes', (props) => expect(props.notes).toHaveLength(3));
  await app.island('notes.recent').assertIslandStatus('unauthorized');
});
```

`assertIsland(component, props)` checks the island's view and props, typed by its controller. When the island's route refuses,
the island gets no props, only an outcome: `assertIslandStatus()` passes for `'unauthorized'` after a redirect or a `401`, for
`'forbidden'` after a `403`, and for `'exception'` after an error. `islanding()` sends the same kind of request to a path you
give, and `response.island()` returns the island's region object. The route name is checked by the compiler, and only an island's
route is accepted:

```text
Argument of type '"notes.index"' is not assignable to parameter of type '"'notes.index' renders a page, not an island — its controller returns this.view(…); an island's returns this.island(…)"'.
```

## Layers

`layer(name, params, query)` opens a layer the way `<Link layer>` does. `layering()` sends any other request from inside a layer,
such as the form that saves it:

```ts title="modules/notes/edit.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import type { EditNoteController } from './controllers/EditNoteController.ts';
import { NoteFactory } from './factories/NoteFactory.ts';

it('edits a note in a layer over the note', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const note = await app.factory(NoteFactory).create({ user_id: ada.id, title: 'Groceries' });

  const opened = await app.actingAs(ada).layer('notes.edit', { note: note.id }).assertOk();
  opened.assertLayer<EditNoteController>('notes/Edit', { note: { title: 'Groceries' } });

  const deepLink = await app.actingAs(ada).get(`/notes/${note.id}/edit`, { headers: { accept: 'text/html' } }).assertOk();
  deepLink.assertPage('notes/Show');
  expect(deepLink.layers().map((layer) => layer.component)).toEqual(['notes/Edit']);

  await app
    .actingAs(ada)
    .layering()
    .put(`/notes/${note.id}`, { json: { title: 'Shopping', body: '' } })
    .assertLayerClosed({ reload: ['note'] })
    .assertFlash('toast', { message: 'Note saved.' });
});
```

`assertLayer(component, props)` passes for a layer's page object, typed by its controller. A request of the layer's URL without
`layer()` is a deep link: the document renders the base page, and `layers()` lists the layers stacked on it, bottom first.
`assertLayerClosed({ layers, reload })` passes when the answer closes the layer, one layer unless `layers` says more, and reloads
the props in `reload` beneath it. The [dialogs](dialogs.md) page explains layers.

## Instant visits

`app.placeholder(route, instant)` renders the placeholder an [instant visit](navigation.md#instant-visits) shows before the page's
answer: the target view's `placeholder`, with what the link passes, inside the view's layouts. It needs `ssr: true`. The markup it
returns has `assertSee()` and `assertDontSee()`, and the page's own text is never in it:

```ts title="modules/notes/instant.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('shows the title at once, and nothing of the page', async () => {
  const app = await createTestApp(application, { ssr: true });

  const placeholder = await app.placeholder('notes.show', { title: 'Groceries' });
  placeholder.assertSee('Groceries').assertSee('Loading…').assertDontSee('Milk');
});
```

`instant` is typed by the controller's `declare readonly instant: { … }`, as the link's `instant` prop is. Leave it out, or pass
`true`, when the controller declares `instant: {}`. A wrong key, or a route whose controller declares none, is a compile error:

```text
Object literal may only specify known properties, but 'titel' does not exist in type '{ title: string; }'. Did you mean to write 'title'?
```

The layouts render without the page's props and the shared props, as for a guest. The page's `url` is the route's pattern, and there
is no `locale`.

The helper finds the view in `.marmeon/routes.json`, which lists the page a controller writes out once (`this.view('notes/Show', …)`).
It fails, with the reason, for a route whose controller computes the view's name, for a view without a `placeholder` and
for a placeholder that throws. `html` holds the markup as a string, for a check the two assertions do not cover.

## Actions

`acting()` sends a request as `useAction()` does. An action's answer is its data, a `422` with the field errors, or, for a
redirect, a `204` with the target in a header. Any controller can answer an action, also one that redirects:

```ts
await app.actingAs(ada).acting().delete(`/notes/${note.id}`).assertOk().assertJson({ deleted: note.id }).assertFlash('toast');
await app.actingAs(ada).acting().post('/notes', { json: { title: 'Groceries' } }).assertActionRedirect();
```

`assertActionRedirect(url)` passes for that `204`, and with `url` when it leads there. The [actions](actions.md) page covers
actions. The mails, jobs and live hints an action leaves behind land on the [fakes](fakes.md), where the test checks them.

## Server rendering

By default a test answer carries the page object only, and no markup: fast, and without Vite. With `ssr: true` the test app
renders pages on the server through the app's `vite.config.ts`, as `marmeon dev` does, so the markup and the document head are
testable:

```ts title="modules/notes/ssr.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteFactory } from './factories/NoteFactory.ts';

it('renders a note on the server, and the browser takes it over', async () => {
  const app = await createTestApp(application, { database: 'refresh', ssr: true });
  const ada = await app.factory(UserFactory).create();
  const note = await app.factory(NoteFactory).create({ user_id: ada.id, title: 'Groceries' });
  await app
    .actingAs(ada)
    .get(`/notes/${note.id}`, { headers: { accept: 'text/html' } })
    .assertOk()
    .assertServerRendered()
    .assertHydrates()
    .assertSee('<h1>Groceries</h1>');
});
```

- **`assertServerRendered()`** fails with the error the render threw, in the page's frame or after it.
- **`assertHydrates()`** renders the page again from the JSON the browser receives and compares the markup. A prop that the
  server renders differently from what it sends fails here, such as a `Date` that reaches the browser as a string. The comparison
  uses the response's CSP nonce, as the browser reads the document. It also fails when the browser's HTML parser would build
  another tree than the markup says, such as a [link that sends](navigation.md#links-that-send) inside a `<p>`.
- **`assertSee(text)`** and **`assertDontSee(text)`** search the markup. Without `ssr`, the body holds only the page object's
  JSON.

The test app renders every page completely, its islands included, as for a search engine, so the markup does not depend on
timing. An island with `load="visible"` is never rendered on the server. The first render of a test app starts Vite and loads
the page's modules, which takes a moment. A test file with many rendering tests can share one app made in `beforeAll` and closed
in `afterAll`, at the price that its tests share one database transaction.

### One Vite server per file

Every `ssr: true` test app starts its own Vite server, which costs seconds. `startSsrServer(application)` starts one that all the
test apps of a file share, so each test keeps its own app, database transaction and session:

```ts title="modules/notes/ssr.test.ts"
import { createTestApp, startSsrServer, type SsrServer } from '@marmeon/testing';
import { afterAll, beforeAll, it } from 'vitest';
import application from '../../bootstrap/app.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
}, 30_000);
afterAll(() => server?.close());

it('renders a note on the server', async () => {
  const app = await createTestApp(application, { database: 'refresh', ssr: true, ssrServer: server });
  await app.get('/notes/1', { headers: { accept: 'text/html' } }).assertServerRendered();
});
```

- Closing a test app never closes the server. Close it in `afterAll`; a test app made on a closed server throws.
- `ssrServer` needs `ssr`, and the server must come from the same application (the same `root`). Both throw otherwise.
- Render errors and resolved islands belong to the request that caused them, never to another test app.
- The server keeps the modules it has loaded, as `marmeon dev` does. A test that changes the state of a view module, such as a
  module-level cache, starts a server of its own.

### Streaming

`ssr: 'stream'` answers as for a browser: the page's frame first, then the islands and deferred props that were not ready, in the
same response. `app.stream(path)` resolves with the raw `Response` before its body is read, so a test can follow the parts as
they arrive:

```ts
const response = await app.actingAs(ada).stream(`/notes/${note.id}`);
const html = await response.text();
expect(html).toMatch(/data-island="notes\.recent" data-status="ready"/);
```

`assertHydrates()` works for a streamed page too: it compares the document as it stands once every part arrived. The
[pages](pages.md#server-rendering) page explains streaming.

## Components on their own

Tests run in Node, without a browser. A component that needs no request can render to a string with React's server renderer.
A test file ends in `.test.ts`, so build the element with `createElement`:

```ts title="modules/notes/note-title.test.ts"
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { NoteTitle } from './components/NoteTitle.tsx';

it('marks a pinned note', () => {
  const markup = renderToStaticMarkup(createElement(NoteTitle, { title: 'Groceries', pinned: true }));
  expect(markup).toBe('<h2>Groceries <small>Pinned</small></h2>');
});
```

Effects do not run in a server render, and nothing is clicked. A component that translates needs the translation context
around it, as the starter kit's own dialog test shows. Behaviour that needs a browser, such as a click, a focus or a view
transition, is best checked in the running app.
