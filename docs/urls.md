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

A [localized route](routing.md#routes-under-a-locale) needs no `locale` in the browser: it takes the locale of the page on screen,
and `params={{ locale: 'de' }}` or `route('about', { locale: 'de' })` chooses another. Only the page's own value is trusted:
a locale you write is encoded into the path's first segment like any parameter, so it can lead to a page of this site that does
not exist, never to another host. On the server, `router.url()` keeps `locale` required.

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
    return this.#signer.signedRoute('notes.shared', { note: noteId }, { expiresIn: { days: 7 }, base: this.#app.url });
  }
}
```

| Method | What it signs |
| --- | --- |
| `signedRoute(name, params, { expiresIn, base })` | A named route, valid for `expiresIn`: seconds, or a [`Duration`](time.md#spans-of-time) such as `{ days: 7 }`. |
| `foreverSignedRoute(name, params, { base })` | A named route that never expires. |
| `signedPath(path, { query, expiresIn, base })` | A path without a route name, such as a file's, valid for `expiresIn`. |
| `hasValidSignature(url, { forever })` | Checks a URL yourself; a link without `expires` passes only with `forever: true`. |

The signature is an HMAC-SHA-256 over the path and the sorted query, with the expiry in it. Parameters the path does not take go
into the query and are signed with it. `signature` and `expires` are reserved and throw as parameter names. `base` puts your
address in front, for an absolute link.

`expiresIn` is required: `signedRoute()` and `signedPath()` refuse a call without it, in the types and at run time. A link that
must work for good, such as an unsubscribe link in a mail already sent, says so with `foreverSignedRoute()`; its URL has no
`expires`, and the name is the one place to find every such link.

`signed()` answers 403, "Invalid signature.", for a missing, changed or expired signature, and for a link without `expires`. The
comparison takes constant time. A route whose links come from `foreverSignedRoute()` says so itself: `signed({ forever: true })`.
So the policy sits on the route, and a forever link opens no route that did not ask for one. An expired link is refused in both
modes. `hasValidSignature(url)` refuses a link without `expires` the same way; `hasValidSignature(url, { forever: true })`
accepts one, for code that checks without the middleware, such as the `describeAccess()` above.

`signed({ withoutCsrf: true })` also leaves a request out of [CSRF verification](csrf.md#a-link-in-a-mail-that-posts), but only when
its signature is valid: a one-click unsubscribe that a mail client posts has no token. It combines with `forever`.

The signing key is derived from `APP_KEY`, a key of its own that signs nothing else. Links signed with a key in
`APP_PREVIOUS_KEYS` stay valid, so rotating the key does not break the links in sent mails. The host is not signed: a link works
on every host of the app, since behind a proxy the request's host is not always the public one. The expiry follows the app's
clock, so a test can travel past it.

> [!WARNING]
> A signed URL is a key in itself: whoever has it may use it until it expires, and it ends up in browser histories and mail
> archives. Give every link an `expiresIn` as short as its purpose allows, and reach for `foreverSignedRoute()` only when a link
> truly has to outlive its mail. A route that acts on an account needs
> `authenticate()` as well, as the starter kit's address confirmation does.

## A link that is used once

A signed URL cannot be used up or taken back: the signature says only that your app made it, and it holds until it expires. A link
that works once, or that its owner can revoke, needs a row to remember it. `linkToken()` makes the token for the link and the hash
to keep in that row; `hashLinkToken()` finds the row again from the token a request brings:

```ts title="modules/events/TicketRepository.ts"
import { hashLinkToken, linkToken } from '@marmeon/encryption';
import { Repository, sql, type Row } from '@marmeon/database';

export class TicketRepository extends Repository<'tickets'> {
  static table = 'tickets' as const;

  /** A new ticket: the token comes back once, for the link. The table keeps its hash. */
  async issue(eventId: number): Promise<string> {
    const { token, hash } = linkToken();
    await this.insert({ event_id: eventId, token_hash: hash });
    return token;
  }

  /** `/tickets/:ticket` → the row, or `undefined` for a 404. */
  override resolveRouteBinding(token: string): Promise<Row<'tickets'> | undefined> {
    return this.query().selectAll().where(sql<boolean>`${sql.ref('token_hash')} = ${hashLinkToken(token)}`).where('used_at', 'is', null).executeTakeFirst();
  }

  /** True for exactly one caller, however many arrive at once: the update decides, not an earlier read. */
  async redeem(id: Row<'tickets'>['id']): Promise<boolean> {
    const result = await this.db.updateTable('tickets').set({ used_at: new Date() }).where('id', '=', id).where('used_at', 'is', null).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
}
```

The column is `table.string('token_hash', 64).secret().unique()`: a secret column stays out of every `select *`, and the unique index
is what finds the row. The token has 32 random bytes (256 bits) as 43 characters of base64url. `hash` is the SHA-256 of the token
in hex, and it needs no key: a copy of the table opens no link, and rotating `APP_KEY` does not kill one, as a signed URL does
unless the old key stays in `APP_PREVIOUS_KEYS`.

`hashLinkToken()` first checks the shape. A value that is no token (too short, too long, other characters, no string) is hashed
whole under a domain of its own, cut to 512 characters: it runs the same indexed query as a real token, matches no row and costs
the same, so a request learns nothing from how long the answer takes. Answer every failure with the same 404: a link that does
not exist, one that was used and one that was revoked must look alike. The GET is open to everyone, with the binder marked
`{ public: true }`, since the token is the key. The POST changes data, so it gets a check of its own that names the link, and a
plain binder: see [every route decides](authorization.md#every-route-decides).

```ts title="modules/events/routes.ts"
const holdsTicket = describeAccess((ctx) => ctx.params.ticket !== undefined, 'ticket link');

Route.authorize(everyone).bind('ticket', TicketRepository, { public: true }).get('/tickets/:ticket', ShowTicketController);
Route.authorize(holdsTicket).bind('ticket', TicketRepository).post('/tickets/:ticket', UseTicketController);
```

Use a signed URL where reuse and passing on do no harm: a read-only link, such as the shared note above. A link that signs someone
in or acts on an account is used once, and needs a row with a hashed token. So does a ticket, or an invitation into a team: it must
not work twice, and its owner must be able to take it back.

Use the link up in a POST, never in the GET that opens it: mail scanners and link previews fetch every link in a mail. The GET
shows a page with a button, and the button's POST calls `redeem()`. A page whose URL holds the token must not be cached and must
not send the token on in a `Referer`, so it answers with `Cache-Control: no-store, private` and `Referrer-Policy: no-referrer`;
set both headers yourself for now. A helper for this page is to follow.

### The same link, sent more than once

A mail that is sent again, or retried by the queue, must carry the same link. Then the token cannot be thrown away after the first
send. Keep it stable, but encrypted, in a second `secret()` column next to the hash, and look the row up by the hash only:

```ts title="modules/events/TicketLinks.ts"
import { Encrypter, linkToken } from '@marmeon/encryption';

export class TicketLinks {
  readonly #encrypter: Encrypter;
  readonly #tickets: TicketRepository;

  constructor(encrypter: Encrypter, tickets: TicketRepository) {
    this.#encrypter = encrypter;
    this.#tickets = tickets;
  }

  async issue(eventId: number): Promise<number> {
    const { token, hash } = linkToken();
    const ticket = await this.#tickets.insert({
      event_id: eventId,
      token_hash: hash,
      token_sealed: await this.#encrypter.encrypt(token, 'tickets:token'),
    });
    return ticket.id;
  }

  /** The link for a mail: decrypted when it is sent, so neither the table nor the job carries it in the clear. */
  async link(ticketId: number): Promise<string> {
    // A query of its own: `select([(eb) => secret(eb, 'token_sealed')])` on the ticket's row.
    const sealed = await this.#tickets.sealedToken(ticketId);
    return `/tickets/${await this.#encrypter.decrypt(sealed, 'tickets:token')}`;
  }
}
```

The job takes the ticket's id, not the token, and the mail builds the link when it is sent. The encrypted column is never searched:
only the hash is, through the unique index. The sealed token follows `APP_KEY`, so rotating the key needs the old one in
`APP_PREVIOUS_KEYS` as long as such a link may still be sent. See [rotating the key](encryption.md#rotating-the-key).

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
  const link = app.make(UrlSigner).signedRoute('notes.shared', { note: 1 }, { expiresIn: { days: 7 } });
  app.travel({ days: 8 });
  await app.get(link).assertForbidden();
});
```

The [HTTP tests](http-tests.md) page covers requests, and the [time](time.md) page the test clock.
