# URL Generation

## Introduction

Links, redirects and forms refer to routes by their name, and the framework builds the URL. A path can then change without a link
breaking, and a name that does not exist is a compile error. On the server, the `Router` builds the URL of a named route:

```ts title="modules/notes/NoteLinks.ts"
import { Router } from '@marmeon/http';

export class NoteLinks {
  readonly #router: Router;

  constructor(router: Router) {
    this.#router = router;
  }

  show(id: number): string {
    return this.#router.url('notes.show', { note: id }, { tab: 'history' }); // /notes/7?tab=history
  }
}
```

In the browser, `<Link route="notes.show" params={{ note: 7 }}>` and `useRoute()` build the same URL from the same names.

## URLs for named routes

### On the server

`router.url(name, params, query)` fills the route's path with `params` and appends `query`. Inside a controller, a redirect takes
the same arguments: `this.redirect().route('notes.show', { note: id })`.

- **Parameters** fill the path's `:name` segments, percent-encoded. The values `.` and `..` are refused with an error: a browser resolves even their encoded forms as dot segments, so the link would lead to another route; validate a value a user chooses, such as a slug, when it is stored, because linking to `.` or `..` throws. A parameter the path does not take goes into the query
  string.
- **The query** is the third argument: `{ tab: 'history', page: 2 }` becomes `?tab=history&page=2`. `null` and `undefined` are
  left out, and a list repeats its key: `{ tag: ['a', 'b'] }` becomes `?tag=a&tag=b`.
- **An optional parameter** that you leave out leaves its segment out of the path.

Everything is checked against `bootstrap/routes.ts`, which `marmeon route:types` writes. A wrong name is a compile error with a
suggestion, a required parameter cannot be left out, and the query of a route with a query schema is typed by its fields:
`page: 2`, not `'2'`. The [routing](routing.md#typed-route-names) page explains the file.

The checks also hold at run time, for a name the compiler did not see. An unknown name throws `[marmeon:H4] Route [notes.shwo] is not defined.`,
and a missing parameter throws `Missing required parameter [note] for route [notes.show].`

### Absolute URLs

`router.url()` returns a path, which is what links and redirects need. A link that leaves the app, say in a mail, needs your
app's address in front of it. The starter's `AppConfig` holds `APP_URL`. The same `NoteLinks` class, now with `AppConfig` and an
`absolute()` method beside `show()`, puts it in front:

```ts
import { Router } from '@marmeon/http';
import { AppConfig } from '../../config/app.ts';

export class NoteLinks {
  readonly #router: Router;
  readonly #app: AppConfig;

  constructor(router: Router, app: AppConfig) {
    this.#router = router;
    this.#app = app;
  }

  absolute(id: number): string {
    return new URL(this.#router.url('notes.show', { note: id }), this.#app.url).href; // https://example.com/notes/7
  }
}
```

Build absolute links from `APP_URL`, never from the request's `Host` header, which the client chooses.

## In the browser

`<Link>` and `useRoute()` of `@marmeon/react` take route names, typed by the same `bootstrap/routes.ts`:

```tsx title="modules/notes/views/Index.tsx"
import type { PageProps } from '@marmeon/http';
import { Link, useRoute } from '@marmeon/react';
import type { ListNotesController } from '../controllers/ListNotesController.ts';

export default function Index({ notes }: PageProps<ListNotesController>) {
  const route = useRoute();
  return (
    <ul>
      {notes.map((note) => (
        <li key={note.id}>
          <Link route="notes.show" params={{ note: note.id }}>{note.title}</Link>
          <button type="button" onClick={() => navigator.clipboard.writeText(route('notes.show', { note: note.id }))}>Copy link</button>
        </li>
      ))}
    </ul>
  );
}
```

The browser builds the URL itself, from a route manifest that the build writes. The [navigation](navigation.md) page covers
links, their options and the router of the page.

### Which routes the browser knows

The browser learns only the routes it needs:

- **The named routes of the `web` group** may go to the browser, by default.
- **API routes** stay on the server, unless `clientRoutes.include` lists them.
- **`.internal()` routes** never go, whatever the lists say.
- **`clientRoutes.except`** keeps more names out, and wins over `include`.

`defineApplication()` takes both lists. A `*` in a pattern matches anything:

```ts title="bootstrap/app.ts"
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  clientRoutes: { include: ['api.notes.index'], except: ['admin.*'] },
});
```

Of the routes the browser may learn, a client build ships only the names your client code writes out: at a `<Link route>`, an
`<Island route>`, a `<Form route>`, the function `useRoute()` returns, `useForm(name, …)`, `useAction(name)`, `usePending(name)` and
`useQueryState(name, …)`. A route only the server links to never reaches the bundle. The server knows every route either way.

Naming a route in client code that the browser may not learn is a compile error:

```text
'auth.verification.verify' is not sent to the browser — API routes, .internal() routes and clientRoutes.except stay on the server
```

### Names written out

The build reads the names from your code, so they must be written as literals. A name built at runtime fails the build, and the
dev server reports it too:

```text
route names sent to the browser must be written out: `notes.${tab}` (route()) is built at runtime, so the build cannot tell which routes this page needs. Did you mean one of …
```

The message names the routes that fit and suggests the literals. Write each name out: `tab === 'show' ? 'notes.show' :
'notes.edit'`. Route names never come from props either: when the server decides the target, it sends the URL, built with
`router.url()`.

A route the manifest lacks at run time throws `[marmeon:C2]`, followed in development by the reason. The
[error handling](errors.md#error-codes) page lists these codes.

## Signed URLs

A signed URL proves that your app made it. It suits a link that works without signing in, such as a note shared with someone who
has no account, or the address confirmation in a mail: nobody can change its parameters or make one up. `UrlSigner` signs a named
route, and the `signed()` middleware checks the signature:

```ts title="modules/notes/routes.ts"
import { defineRoutes, describeAccess, signed, UrlSigner } from '@marmeon/http';
import { ShowSharedNoteController } from './controllers/ShowSharedNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';

// The signature is the decision here, and the check verifies it itself: it holds without `signed()` too.
const signedLink = describeAccess((ctx, resolve) => resolve(UrlSigner).hasValidSignature(ctx.request.url), 'signed link');

export default defineRoutes((Route) => {
  Route.middleware(signed())
    .authorize(signedLink)
    .bind('note', NoteRepository)
    .get('/shared/:note', ShowSharedNoteController)
    .name('notes.shared')
    .internal();
});
```

A signature is not a decision about who may call the route: `signed()` proves the link is genuine, and the route still says who
may call it. Here the link is the whole key: only your app can make one, so the check verifies the signature itself, and the
decision stands even without the `signed()` middleware. It names the signature in `route:list`. It is not `everyone`, which would refuse the binding, since an open route may not look a note up by any
key. See [every route decides](authorization.md#every-route-decides).

The route is `.internal()`, since only the server builds its links. A service signs one:

```ts title="modules/notes/ShareLinks.ts"
import { UrlSigner } from '@marmeon/http';
import { AppConfig } from '../../config/app.ts';

export class ShareLinks {
  readonly #signer: UrlSigner;
  readonly #app: AppConfig;

  constructor(signer: UrlSigner, app: AppConfig) {
    this.#signer = signer;
    this.#app = app;
  }

  share(noteId: number): string {
    return this.#signer.temporarySignedRoute('notes.shared', { note: noteId }, '7d', { base: this.#app.url });
  }
}
```

| Method | What it signs |
| --- | --- |
| `signedRoute(name, params, { base })` | A named route, valid forever. |
| `temporarySignedRoute(name, params, expiresIn, { base })` | A named route, valid for `expiresIn`: seconds, or `'30s'`, `'60m'`, `'2h'`, `'7d'`. |
| `signedPath(path, { query, expiresIn, base })` | A path without a route name, such as a file's. |
| `hasValidSignature(url)` | Checks a URL yourself. |

The signature is an HMAC-SHA-256 over the path and the sorted query, with the expiry in it. Parameters the path does not take go
into the query and are signed with it. `signature` and `expires` are reserved and throw as parameter names. `base` puts your
address in front, for an absolute link.

`signed()` answers 403, "Invalid signature.", for a missing, changed or expired signature. The comparison takes constant time.

The signing key is derived from `APP_KEY`, a key of its own that signs nothing else. Links signed with a key in
`APP_PREVIOUS_KEYS` stay valid, so rotating the key does not break the links in sent mails. The host is not signed: a link works
on every host of the app, since behind a proxy the request's host is not always the public one. The expiry follows the app's
clock, so a test can travel past it.

> [!WARNING]
> A signed URL is a key in itself: whoever has it may use it until it expires, and it ends up in browser histories and mail
> archives. Give every link an `expiresIn` as short as its purpose allows. A route that acts on an account needs
> `authenticate()` as well, as the starter kit's address confirmation does.

## Testing

A test builds URLs with the app's own router and signer:

```ts title="modules/notes/share.test.ts"
import { UrlSigner } from '@marmeon/http';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('refuses an expired link', async () => {
  const link = app.make(UrlSigner).temporarySignedRoute('notes.shared', { note: 1 }, '7d');
  app.travel({ days: 8 });
  await app.get(link).assertForbidden();
});
```

The [HTTP tests](http-tests.md) page covers requests, and the [time](time.md) page the test clock.
