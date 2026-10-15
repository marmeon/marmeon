# Responses

## Introduction

What a controller returns becomes the response. Most controllers answer with a page or a redirect, and the base class `Controller`
has a method for each kind of answer:

```ts title="modules/notes/controllers/ShowNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';

export class ShowNoteController extends Controller {
  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    if (ctx.params.note.user_id !== ctx.user.id) return this.redirect().route('notes.index');
    return this.view('notes/Show', { note: ctx.params.note });
  }
}
```

A result is a description, not a finished response. The framework turns it into one at the end of the request, because only then
does it know who asked: a browser's first visit gets a server-rendered document, a visit inside the app gets the page as JSON.

## Pages

`this.view(name, props, status)` answers with a page. The name is the view's path inside its module's `views/` folder:
`notes/Show` is `modules/notes/views/Show.tsx`. A name without a view is a compile error, and so is a prop the view does not get,
since the view takes its props from the controller's type:

```tsx title="modules/notes/views/Show.tsx"
import type { PageProps } from '@marmeon/http';
import { Head } from '@marmeon/react';
import type { ShowNoteController } from '../controllers/ShowNoteController.ts';

export default function Show({ note }: PageProps<ShowNoteController>) {
  return (
    <main>
      <Head title={note.title} />
      <h1>{note.title}</h1>
      <p>Written {note.created_at}</p>
    </main>
  );
}
```

Props travel as JSON, and the view's types say so: a `Date` prop arrives as a string, a `Map` as an empty object, and a field that
is `undefined` not at all. Send only what the page shows. Every prop reaches the browser, so a column such as a password hash must
never be in it.

The status defaults to 200. `this.view('notes/Gone', { id }, 410)` sends another. The [pages](pages.md) page covers views, layouts
and the head.

### Props that load later

A prop can be more than a value. A function is called only when the response includes the prop, `optional()` sends a prop only
when the page asks for it, `defer()` loads it right after the page shows, and `merge()` appends what a partial reload brings:

```ts title="modules/notes/controllers/ShowNoteHistoryController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, defer, optional, type HttpContext } from '@marmeon/http';
import { NoteHistory } from '../NoteHistory.ts';

export class ShowNoteHistoryController extends Controller {
  readonly #history: NoteHistory;

  constructor(history: NoteHistory) {
    super();
    this.#history = history;
  }

  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    const { note } = ctx.params;
    return this.view('notes/Show', {
      note,
      history: defer(() => this.#history.of(note.id)),
      stats: optional(() => this.#history.stats(note.id)),
    });
  }
}
```

The [deferred props](deferred-props.md) page explains each of them, with islands and polling.

### Shared props

Some props belong to every page: the signed-in user, the languages of a switcher. A middleware shares them with `SharedData`, and
`interface SharedProps` declares their types:

```ts title="middleware/ShareAppProps.ts"
import { once, SharedData, type HttpContext, type Next } from '@marmeon/http';
import { Locales } from '@marmeon/i18n';

declare module '@marmeon/http/page' {
  interface SharedProps {
    /** Optional: a path without a route passes no group's middleware, and its error page has no shared props. */
    locales?: readonly string[];
    support?: { email: string };
  }
}

export class ShareAppProps {
  readonly #shared: SharedData;
  readonly #locales: Locales;

  constructor(shared: SharedData, locales: Locales) {
    this.#shared = shared;
    this.#locales = locales;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared.share('support', { email: 'help@example.com' }).share('locales', once(() => this.#locales.supported));
    return next();
  }
}
```

List the class in the `web` key of `middleware` in `bootstrap/app.ts`. A function is evaluated only when a page renders, at most
once per request, never for a redirect or JSON. The wrappers of page props work here too. The page's own prop of the same name
wins, and `usePage().props` reads the shared ones in any component.

Declare shared props as optional. A path that matches no route passes no group's middleware, so its 404 page renders without
them, inside the same layout. The starter kit shares the signed-in user as `auth`, and the session shares the validation errors of
the last form as `errors`.

To pass the app's name or a public key from configuration to the browser, share it here. See [values for the
browser](configuration.md#values-for-the-browser).

### Once props

`once()` sends a prop with the first page that has it. The browser then keeps it for as long as the tab shows the app, and tells
the server which ones it holds, so the server skips them on later pages:

```ts
share('locales', once(() => this.#locales.supported));
countries: once(() => this.#countries.all(), { key: 'countries', ttl: 24 * 60 * 60 * 1000 }),
```

The `key` lets several views share one value, and `ttl` in milliseconds sends it again after that time. A full page load, such as
signing in or out, a new build or a language switch, starts over. A once prop is for data that is the same on every page, such as
a country list. Anything that changes while the page is open is a normal prop, and its value must be plain data: a `Map`, a
function or a promise inside it is a compile error.

## Redirects

`this.redirect()` sends the browser elsewhere. Name the route, and its parameters and query are checked against your routes:

```ts title="modules/notes/controllers/StoreNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';

export const StoreNoteRequest = defineRequest({
  schema: r.object({ title: r.string().trim().required().max(120) }),
});

export class StoreNoteController extends Controller {
  static request = StoreNoteRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof StoreNoteRequest> & Authenticated) {
    const note = await this.#notes.insert({ user_id: ctx.user.id, title: ctx.body.title, body: '' });
    return this.redirect().route('notes.show', { note: note.id }, { tab: 'edit' });
  }
}
```

| Call | Goes to |
| --- | --- |
| `this.redirect('/notes')` | The URL as written. |
| `this.redirect().route(name, params, query)` | A named route. Parameters the path does not take go into the query. |
| `this.back(fallback)` | The previous page of this site, from the `Referer` header, or `fallback`, by default `/`. |
| `this.redirect().intended().route(name)` | The page a guest wanted before `authenticate()` sent them to the login, else the route. |

A redirect answers a `GET` with 302 and every other method with 303, so the browser follows a form's `PUT` or `DELETE` with a
`GET`. `.status(301)` sets another status, and `.header(name, value)` adds a header.

`back()` takes only a `Referer` of this host, and `intended()` only a path of this site, so neither can lead to another site. A referring page whose path starts with several slashes or backslashes (`https://app//evil.example`) is sent to `/evil.example` on this site, never to the host that a browser would read out of `//evil.example`.
`this.redirect(url)` goes wherever you say.

A client-side visit, form submission or upload request that is answered with a redirect to another origin (`this.redirect('https://other.example')`)
does not follow it: the server answers `409` with `x-marmeon-location` instead, and the browser leaves the app with a full page
load. The visit's `fetch` would otherwise send its `x-xsrf-token` header on to that origin. "Another origin" is measured against
the origin the request came to, so `//other.example` counts too. Redirects within the app, and the redirects of plain browser
requests, are unchanged.

> [!WARNING]
> Never pass a URL from the request, such as a `?next=` parameter, to `this.redirect(url)`. Anyone could send a link that leads
> through your app to a site of theirs. Check such a value with `isLocalPath()` of `@marmeon/http` first, which accepts only a
> path of this site. A path that dot segments turn into `//host`, such as `/a/..//host`, is refused as well.

### Flash data and flash messages

A redirect can carry data to the next request:

```ts
return this.back().with('email', ctx.body.email);
```

`with(key, value)`, or `with({ … })` for several, keeps the values in the session for the next request, where the injected
`Session` reads them with `get()`. `withErrors(errors)` and `withInput(input)` flash a form's errors and its input. A field whose
name contains "password", "passcode", "secret", "token", "credential", "signature", "jwt", "recovery", "card", "cvc", "cvv" or
"iban", is an API key, private key or session id, or is a one-time code (`otp`, `totp_secret`, `code`, `sms_code`, `backup_codes`;
not `footprint`, `zip_code`, `language_code` or `promoCode`), the `_token` and every file are left out of the input. The framework does both for you when validation
fails, so you rarely call them.

A flash message is something to show the user once, such as "Note saved.":

```ts
return this.redirect().route('notes.index').flash('toast', { kind: 'success', message: 'Note saved.' });
```

It waits in the session for the next response the user sees, and fires exactly once in the browser, where the layout shows it
with `useFlash('toast', …)`. A prefetch or an island in between never takes it. Declare the keys and their data in
`interface FlashData`, and a wrong key or a wrong shape is a compile error:

```ts title="modules/notes/flash.ts"
declare module '@marmeon/http/page' {
  interface FlashData {
    toast: { kind: 'success' | 'error' | 'info'; message: string };
  }
}

export {};
```

A page and an action's JSON can carry a flash message too: `this.view(…).flash(…)` and `this.json(…).flash(…)`. Both flash data
and flash messages need a started session, so a route of the `api` group cannot use them: the redirect fails with an error that
names the route and says to put it in the `web` group, or to add `StartSession` to its group.

## JSON

`this.json(data, status)` answers with JSON. Its type travels to the browser: an action that calls the route gets
`result.data` typed as the data the JSON carries:

```ts title="modules/notes/controllers/PinNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';

export class PinNoteController extends Controller {
  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    await this.#notes.update(ctx.params.note.id, { pinned: true });
    return this.json({ pinned: ctx.params.note.id });
  }
}
```

The status defaults to 200. `this.json(undefined)` answers 204 with no body. An API client gets the same JSON, and the
[actions](actions.md) page shows how a page calls such a route without leaving.

## Other results

| Result | Response |
| --- | --- |
| A `Response` | Goes out as it is. |
| A string | HTML: `text/html; charset=utf-8`. |
| An object or an array | JSON. |
| `null` or `undefined` | An empty 204. |

> [!WARNING]
> A string goes out as HTML. Never put the visitor's input into it unescaped: build HTML with the `html` template below, or
> answer with JSON.

### HTML you write yourself

The `html` template of `@marmeon/core` escapes every value it interpolates, so a name like `<script>` arrives as text:

```ts title="modules/notes/controllers/ShowNoteSnippetController.ts"
import type { Row } from '@marmeon/database';
import { html } from '@marmeon/core';
import { Controller, type HttpContext } from '@marmeon/http';

export class ShowNoteSnippetController extends Controller {
  handle(ctx: HttpContext<{}, { note: Row<'notes'> }>) {
    const { note } = ctx.params;
    return String(html`<article><h1>${note.title}</h1><p>${note.body}</p></article>`);
  }
}
```

Nested templates and lists of them stay markup, and `null`, `undefined` and `false` vanish. `raw(markup)` marks markup you trust,
never input. The escaping covers text and quoted attributes, not URLs: put only links you built yourself into an `href`. A script
tag in such HTML needs the response's nonce, `ctx.nonce()`, under a Content-Security-Policy.

### Headers

A redirect takes headers with `.header(name, value)`. The base class's `this.view()` and `this.json()` take none. For a page or
JSON with a header of its own, return the standalone functions of `@marmeon/http` instead, which take headers as their fourth and
third argument: `view(name, props, status, headers)` and `json(data, status, headers)`:

```ts title="modules/notes/controllers/ShowDraftController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, view, type HttpContext } from '@marmeon/http';

export class ShowDraftController extends Controller {
  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    return view('notes/Show', { note: ctx.params.note }, 200, { 'x-robots-tag': 'noindex' });
  }
}
```

The view's props are typed from this controller the same way. A header that every response of some routes needs belongs in a
middleware, which the [middleware](middleware.md#changing-the-response) page shows.

Pages of a signed-in user go out with `Cache-Control: no-store, private`, so the browser does not show them again after a
sign-out. A route that may be kept sets its own header, for example with the `cacheControl()` middleware:

```ts
Route.middleware(authenticate()).middleware(cacheControl('private, max-age=60')).authorize(everyone).get('/notes/report', ShowReportController);
```

Never use `public` for anything that depends on the user: a shared cache would hand it to the next visitor.

Since that answer stays in the browser's cache, the app signs out with `history.clear({ siteData: ['cache', 'storage'] })` after `logout()`; see [the browser's storage on sign-out](client-features.md#the-browsers-storage-on-sign-out).

### Cookies

`ctx.cookies.set(name, value, options)` queues a cookie for whatever response the request ends with, a page, a redirect or an
error page alike. The [requests](requests.md#cookies) page covers the options and their defaults.

### Downloads

`serveFile()` of `@marmeon/storage` answers with a file of a disk:

```ts title="modules/notes/controllers/DownloadAttachmentController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';
import { serveFile, Storage } from '@marmeon/storage';

export class DownloadAttachmentController extends Controller {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    super();
    this.#storage = storage;
  }

  handle(ctx: HttpContext<Authenticated, { attachment: Row<'attachments'> }>) {
    const { attachment } = ctx.params;
    return serveFile(this.#storage.disk('local'), attachment.path, ctx.request, { cacheControl: 'private, no-store', filename: attachment.name });
  }
}
```

The file streams from the disk with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`. Everything but
raster images goes out as an attachment, so HTML, SVG or a PDF is downloaded instead of shown on your app's origin. A missing file
is a 404. The route's middleware and policy decide who may download: check them as for any other route.

A file the browser should fetch later, say from a mail, gets a signed link instead:
`await this.#storage.disk('local').temporaryUrl(key, { expiresIn: { minutes: 5 } })`. Redirect to it, or send it along. The
[file storage](storage.md#public-and-private-files) page covers disks and their URLs.

## Testing

A test asserts what a controller answered:

```ts title="modules/notes/notes.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import type { ShowNoteController } from './controllers/ShowNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('shows a note to its author', async () => {
  const ada = await app.factory(UserFactory).create();
  const note = await app.make(NoteRepository).insert({ user_id: ada.id, title: 'Draft', body: '' });
  await app.actingAs(ada).get(`/notes/${note.id}`).assertOk().assertPage<ShowNoteController>('notes/Show', { note: { title: 'Draft' } });
});
```

`assertRedirect(url)`, `assertJson(data)`, `assertFlash(key, data)` and `assertHeader(name, value)` check the other kinds of
answer. The [HTTP tests](http-tests.md) page covers every assertion.
