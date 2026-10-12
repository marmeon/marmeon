# Requests

## Introduction

Every controller and middleware gets the request's context, `ctx`. It holds the raw request, the route's parameters, the query
string, the body, the cookies and the client's address:

```ts title="modules/notes/controllers/SearchNotesController.ts"
import { Controller, type HttpContext } from '@marmeon/http';

export class SearchNotesController extends Controller {
  async handle(ctx: HttpContext) {
    const term = ctx.query.get('q') ?? '';
    const input = await ctx.input();
    return this.json({ term, sort: input.sort, theme: ctx.cookies.get('theme'), from: ctx.ip });
  }
}
```

Most controllers read less than this by hand. A request definition validates the body into `ctx.body` and parses the query into a
typed `ctx.query`, so the controller works with checked values. This page covers both ways.

## The request

`ctx.request` is the standard `Request` of the Fetch API: `ctx.request.method`, `ctx.request.url`,
`ctx.request.headers.get('user-agent')`. Behind a trusted proxy, its URL carries the scheme and host the client asked for, taken
from `X-Forwarded-Proto` and `X-Forwarded-Host`.

A plain HTML form can only send `GET` and `POST`. A `POST` whose form body has a `_method` field of `PUT`, `PATCH` or `DELETE`
reaches the router as that method. The field counts only in a form's body, never in the query, so a link cannot change a
request's method. It also counts only within the first 16 KB of the body, before the first file of a multipart form. `<Form>`
writes the field first, so this matters only for a form you write by hand: put `_method` before any file field.

`ctx.route` is the route that matched, and `ctx.params` holds the path's parameters: strings, or records where the route binds
them. The [routing](routing.md#route-parameters) page covers parameters.

## Input

### The body

`ctx.input()` parses the body once and returns it:

```ts title="modules/notes/controllers/ImportNotesController.ts"
import { Controller, type HttpContext } from '@marmeon/http';

export class ImportNotesController extends Controller {
  async handle(ctx: HttpContext) {
    const input = await ctx.input(); // { notes: [{ title: 'A' }, { title: 'B' }] }
    const count = Array.isArray(input.notes) ? input.notes.length : 0;
    return this.json({ received: count });
  }
}
```

It reads JSON objects, `application/x-www-form-urlencoded` and `multipart/form-data` alike. Form fields nest by brackets, as in
`notes[0][title]`, `tags[]` and `user[name]`. An object whose keys are exactly `0` to `n-1` becomes a list, a field named
`__proto__` is dropped, and a later field of the same name wins. Bodies of other types, such as `text/plain`, give `{}`.

The input is the body and only the body. The query string never goes into it, so no link can fill in a field of a form. A `GET`
or `HEAD` request has the input `{}`. The parsed body is kept, so call `ctx.input()` as often as you like, but do not read
`ctx.request`'s body yourself after it: a body can be read only once.

| Request | Answer |
| --- | --- |
| A body over `MAX_BODY_SIZE` | 413. The bytes are counted as they arrive, whatever `Content-Length` says. |
| Malformed JSON | 400, `Malformed JSON body.` |
| JSON that is not an object | 400, `The JSON body must be an object.` |
| A multipart body that cannot be parsed | 400, `Malformed multipart body.` |
| Brackets nested more than 20 levels deep | 400 |

### Validated input

`ctx.input()` gives you whatever the client sent. A request definition checks it first: the controller then reads `ctx.body`, the
schema's output, and never runs for input that failed:

```ts title="modules/notes/controllers/StoreNoteController.ts"
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const StoreNoteRequest = defineRequest({
  schema: r.object({
    title: r.string().trim().required().max(120),
    tags: r.array(r.string().max(30)).max(10).default([]),
  }),
});

export class StoreNoteController extends Controller {
  static request = StoreNoteRequest;

  handle(ctx: ContextOf<typeof StoreNoteRequest>) {
    return this.json({ title: ctx.body.title, tags: ctx.body.tags }); // string, string[]
  }
}
```

Invalid input is a 422 with the errors per field for a JSON client, and a redirect back to the form with the errors and the old
input for a page. The [validation](validation.md) page covers the rules and their messages.

## The query string

Without a query schema, `ctx.query` is the `URLSearchParams` of the URL: `ctx.query.get('page')` is a string or `null`.

### Query schemas

A request's `query` parses the query string into typed values. Links outlive their pages and people type URLs, so a query never
answers 422: a field that does not fit takes its default instead.

```ts title="modules/notes/controllers/ListNotesController.ts"
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const ListNotesRequest = defineRequest({
  query: r.query({
    q: r.string().trim().max(60).default(''),
    sort: r.in(['title', '-title', 'created', '-created']).default('created'),
    tag: r.array(r.string()).default([]),
    page: r.integer().min(1).default(1),
  }),
});

export class ListNotesController extends Controller {
  static request = ListNotesRequest;

  handle(ctx: ContextOf<typeof ListNotesRequest>) {
    // ctx.query: { q: string; sort: 'title' | '-title' | 'created' | '-created'; tag: string[]; page: number }
    return this.view('notes/Index', { query: ctx.query });
  }
}
```

`/notes?sort=DROP%20TABLE&page=2` lists the notes by date on page 2, with a 200. The rules for a query are strict, and the
compiler holds a schema to them:

- **Every field has a default or is optional**, so an empty query is valid and every field can fall back.
- **Every field takes a string**, because a URL holds strings: `r.integer()`, `r.boolean()` and `r.in([10, 25])` take their
  spelling.
- **Every output can go back into a URL**: a string, a number, a boolean or a list of them.

A field that breaks a rule is a compile error naming it, such as `query fields need a default or must be optional: 'page' is
required`.

### How a query is parsed

- A field the schema rejects is taken out, and the rest is checked again, so the field gets its default.
- A key that appears twice is a list: `?tag=a&tag=b`. A single value where the schema wants a list is a list of one: `?tag=a`.
- Keys the schema does not know are ignored, and `__proto__` is no key.
- An empty field such as `?q=` follows the field's type: `''` for `r.string()`, missing for `r.integer()`.

A `GET` with an invalid or unknown field can go to its clean URL instead. `queryOptions: { onInvalid: 'redirect' }` answers it with
a 302 to the same path with only the valid fields that differ from their defaults, so the address bar shows what the page shows.
Requests of other methods always fall back.

The page gets the parsed query and its defaults with it, so the browser never parses a URL itself. `<Link query>` and
`useQueryState()` are typed by the same schema, and the [pagination](pagination.md#searching-and-sorting) page shows them. A
[data table](tables.md#the-url-is-strict) is stricter on purpose: an unknown sort or filter there answers 400.

## Files

A file field of a `multipart/form-data` body arrives in `ctx.input()` as a `File`. The whole body is held in memory and counts
against `MAX_BODY_SIZE`, and an empty file field, where nothing was chosen, is left out.

For files from your users, use the `upload()` rule of `@marmeon/storage` instead. The browser sends the file ahead of its form,
streamed to a private disk with progress, and the form sends a token in its place. On submit, the rule checks the token, the size
and the file's type by its first bytes, never by its name:

```ts title="modules/notes/controllers/AttachFileController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Storage, upload } from '@marmeon/storage';
import { rules as r } from '@marmeon/validation';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const AttachFileRequest = defineRequest({
  schema: r.object({ file: upload({ maxBytes: 5_000_000, mime: ['image/png', 'image/jpeg', 'application/pdf'] }) }),
  authorize: can(NotePolicy, 'update', 'note'),
});

export class AttachFileController extends Controller {
  static request = AttachFileRequest;

  readonly #storage: Storage;

  constructor(storage: Storage) {
    super();
    this.#storage = storage;
  }

  async handle(ctx: ContextOf<typeof AttachFileRequest>) {
    const path = await ctx.body.file.store(this.#storage.disk('local'), `notes/${ctx.params.note.id}`);
    return this.json({ path });
  }
}
```

`store()` uses the upload once and moves it to its place, under a random name. Whoever may send the form may upload its files: the
route's middleware and `authorize` decide both. An upload belongs to the session it was made in. The [file
storage](storage.md#uploads) page explains disks, the uploads table and its clean-up, and the [forms](forms.md#uploads) page shows
the browser's side.

## Cookies

`ctx.cookies` reads the cookies the client sent and queues the ones the response sets:

```ts title="modules/notes/controllers/UpdateNoteLayoutController.ts"
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const UpdateNoteLayoutRequest = defineRequest({
  schema: r.object({ layout: r.in(['grid', 'list']) }),
});

export class UpdateNoteLayoutController extends Controller {
  static request = UpdateNoteLayoutRequest;

  handle(ctx: ContextOf<typeof UpdateNoteLayoutRequest>) {
    ctx.cookies.set('notes_layout', ctx.body.layout, { maxAge: 60 * 60 * 24 * 365 });
    return this.back();
  }
}
```

`get(name)`, `has(name)` and `all()` read what the client sent, never what this request queued. `set(name, value, options)` and
`delete(name, { path, domain })` queue a cookie for whatever response the request ends with: a page, a redirect or an error page.
Pass `delete` the same `path` and `domain` the cookie was set with.

| Option | Default |
| --- | --- |
| `path` | `/` |
| `httpOnly` | `true`: scripts cannot read the cookie. |
| `sameSite` | `lax`. `none` requires `secure`, and throws without it. |
| `secure` | `true` when `APP_URL` starts with `https://`, or as `SESSION_SECURE_COOKIE` says. `secure: false` turns it off for one cookie. |
| `maxAge`, `expires` | none: a session cookie, which ends when the browser session does. |
| `domain` | none: the cookie belongs to the host that set it. |

In the `web` group, every cookie is encrypted with the app's key on its way out and decrypted on its way in. A cookie that fails to
decrypt, such as one a page's script wrote, is gone from `ctx.cookies`. The `XSRF-TOKEN` cookie is the one exception, since your
page's JavaScript reads it. Routes of the `api` group read and write cookies as they are.

Requests that only read, such as an island's, may not set cookies. A `set` there throws in development and in tests, and is
logged and dropped everywhere else.
The [request lifecycle](lifecycle.md#requests-that-only-read) page lists them.

## The client's address

`ctx.ip` is the client's IP address. Without trusted proxies it is the address of whoever connected. Behind a proxy listed in
`TRUSTED_PROXIES`, it is the right-most `X-Forwarded-For` entry that is not a trusted proxy itself, since entries further left are
whatever the client claimed. In tests, `ctx.ip` is undefined.

A service that has no `ctx`, such as a listener of the sign-in event, injects `RequestInfo` of `@marmeon/http` instead. It holds
the request's `ip` and `userAgent`, and both are undefined outside a request. The [deployment](deployment.md#trusted-proxies) page
explains how to list your proxies.

## What the client expects

`ctx.expectsJson()` is true when JSON is the first type in the request's `Accept` header, or for an `XMLHttpRequest` that
accepts anything. The framework asks it too: a guest who expects JSON gets a 401 from `authenticate()` instead of a redirect to
the login page, and invalid input gets a 422 with the errors instead of a redirect back to the form.
These answers, and the redirects they replace, carry `Vary: Accept, X-Requested-With`; your own middleware should do the same, see
[middleware](middleware.md#middleware-objects).

## The CSP nonce

`ctx.nonce()` returns the nonce of the response's Content-Security-Policy, the same value for the whole response. Pages rendered
from `index.html` carry it already, so you need it only for HTML your controller writes itself:
`<script nonce="${ctx.nonce()}">`. The [Content Security Policy](csp.md#the-nonce) page explains the policy.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `MAX_BODY_SIZE` | `8m` | The largest request body, in bytes or with a unit: `512k`, `8m`, `1g`. A larger body is a 413. Uploads through `upload()` have their own limit. |
| `TRUSTED_PROXIES` | none | The proxies whose `X-Forwarded-*` headers count, as addresses or ranges, or `*`. |

## Testing

A test sends the body as a form, as JSON or as multipart, and the query in the path:

```ts title="modules/notes/notes.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('falls back to the default sort', async () => {
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).get('/notes?sort=nope').assertOk().assertPage('notes/Index');
});
```

`app.post(path, { form })`, `{ json }` and `{ multipart }` send the body, and `app.upload()` sends a file the way the browser
does. The [HTTP tests](http-tests.md) page covers every request helper.
