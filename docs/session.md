# Session

## Introduction

HTTP requests know nothing of each other. A session keeps data for one visitor from one request to the next: who signed in, the
errors of the last form, the language they chose. The `StartSession` middleware of the `web` group loads it before the route
runs and saves it after the response is ready. A controller injects the request's `Session`:

```ts title="modules/notes/controllers/ShowNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';
import { Session } from '@marmeon/session';

declare module '@marmeon/session' {
  interface SessionData {
    /** The notes this visitor opened last, newest first. */
    recentNotes: number[];
  }
}

export class ShowNoteController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    const { note } = ctx.params;
    const recent = this.#session.get('recentNotes') ?? [];
    this.#session.put('recentNotes', [note.id, ...recent.filter((id) => id !== note.id)].slice(0, 5));
    return this.view('notes/Show', { note, recent });
  }
}
```

`interface SessionData` declares the keys and their types, so `put('recentNotes', 'x')` is a compile error. The session is scoped
to the request: every class that injects it during the request gets the same one, and no other request ever does. The routes of
the `api` group have no session.

## Using the session

### Reading and writing

| Method | What it does |
| --- | --- |
| `get(key)` | The value, or `undefined`. |
| `put(key, value)` | Stores a value. |
| `pull(key)` | Returns the value and removes it. |
| `has(key)` | Whether the key holds a value. |
| `forget(...keys)` | Removes keys. |
| `all()` | Everything, without the framework's own keys, which start with `_`. |
| `flush()` | Removes everything, the CSRF token included. |

Values are stored as JSON, so they must survive `JSON.stringify()`: a `Date` comes back as a string. A key that `SessionData` does
not declare holds `unknown`.

### Flash data

Flash data lives for the current and the next request, then it is gone:

```ts
this.#session.flash('importedCount', 12);
```

`keep(...keys)` keeps flash data for one more request, and `reflash()` keeps all of it. A redirect flashes data with
`.with(key, value)`, and the next request reads it with `get()`. A message to show the user once, such as "Note saved.", is a
flash message: `.flash(key, data)` on a redirect, a page or JSON. The [responses](responses.md#flash-data-and-flash-messages) page
explains both.

A failed form flashes its errors and its input. The session's `ShareErrorsFromSession` middleware then shares the errors as the
`errors` prop with every page of the `web` group, `{}` when there are none, so a form shows them next to its fields. `old(key)`
returns the flashed input. The failed form, `redirect().withInput(input)` and `session.flashInput(input)` all leave out every
field whose name contains "password", the `_token` and every file, also inside nested objects and lists. So a password never
reaches the session store through flashed input.

### Signing in and out

Signing in calls `regenerate()`: the session gets a new id and a new CSRF token, and keeps its data. Signing out calls
`invalidate()`, which also drops all data. The old id is destroyed when the request saves the session, so a stolen id from before
the sign-in signs nobody in. The authentication package calls both for you. Call `regenerate()` yourself whenever a session's
privileges change in another way.

## When a session is kept

A request without a session cookie starts a new session. It is saved, and its cookie sent, only once something is written into it:
data, flash data, the errors of a failed form, a sign-in. A guest's page keeps no session, and neither do health checks, bots,
prefetches or JSON endpoints that never touch it. So a visitor who only reads leaves nothing behind: no file, no row, no cookie.
Their forms still pass the CSRF check by the browser's word, which the [CSRF protection](csrf.md#how-a-request-is-checked) page
explains.

A session that came from its store is always written back. To keep a new session with nothing in it, call `persist()`. A guest's
page with an upload field does so in its controller, since an upload belongs to a session. `token()` keeps it as well, since the
token it hands out must still be valid when it comes back.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `SESSION_DRIVER` | `file` | Where sessions live: `file`, `database`, `redis` or `memory`. |
| `SESSION_CONNECTION` | `default` | The database or Redis connection of the `database` and `redis` drivers. |
| `SESSION_LIFETIME` | `120` | Minutes without a request until the session expires on the server. The cookie itself has no expiry. |
| `SESSION_COOKIE` | `marmeon_session` | The name of the session cookie. Over HTTPS the browser sees it with the [`__Host-` prefix](#the-__host--prefix). |
| `SESSION_FILES` | `storage/framework/sessions` | Where the `file` driver keeps sessions, relative to the app. |
| `SESSION_SECURE_COOKIE` | follows `APP_URL` | `true` or `false` decides `Secure` yourself. Unset, every cookie gets it when `APP_URL` starts with `https://`. |
| `SESSION_SAME_SITE` | `lax` | The `SameSite` attribute of the session cookie: `lax`, `strict` or `none`. |
| `SESSION_ENCRYPT` | `false` | `true` encrypts the session data in its store with `APP_KEY`. |
| `SESSION_LOTTERY` | `2/100` | The chance that a request also deletes expired sessions, after its response. `0/1` turns it off. |

### Secure cookies

`SESSION_SECURE_COOKIE` covers every cookie of a request, not only the session's: the `XSRF-TOKEN`, the remember-me token and any
cookie your code sets without saying otherwise. An app served as `https://` therefore sends no cookie over plain HTTP. Behind a
proxy that terminates TLS, nothing else is needed, since the decision comes from `APP_URL` and not from the request.

The session cookie itself is encrypted like every cookie of the `web` group, `HttpOnly`, so no script can read it, and sent with
the `SameSite` of `SESSION_SAME_SITE`. It has no `Max-Age` or `Expires`: the browser drops it when it closes (see
[expiry](#expiry-and-clean-up)). `SameSite=None` requires `Secure`: with `SESSION_SAME_SITE=none` and cookies without
`Secure`, every response that sets the session cookie throws.

### The `__Host-` prefix

When cookies are `Secure`, the session cookie is called `__Host-marmeon_session` (`SESSION_COOKIE` with the prefix). A browser accepts
a `__Host-` cookie only if it is `Secure`, has `Path=/` and no `Domain` attribute, so a page on a neighbouring subdomain cannot set
a session cookie for the whole domain and plant its own session on a visitor. The framework sets the cookie that way and refuses to
set any `__Host-` name without `Secure`, with a `Domain` or with another path. Over plain HTTP, in development, the cookie goes by
its bare name: a browser would refuse the prefix there.

Only the name `sessionCookieName(config)` returns is ever read. When cookies are `Secure`, a cookie under the bare name is ignored, even
if the prefixed one is missing. `SESSION_COOKIE` itself must not start with `__Host-` or `__Secure-`: the app does not start. Tests that set the cookie by hand name it
through `sessionCookieName()` as well:

```ts
import { SessionConfig, sessionCookieName } from '@marmeon/session';

const name = sessionCookieName(app.container.make(SessionConfig));
```

Outside development and tests, an app whose cookies go without `Secure` says so once at start-up:

```text
Cookies are sent without Secure: APP_URL is not https:// — the session cookie travels in plain text. Serve the app over HTTPS and set APP_URL=https://…
```

## Drivers

| Driver | Where the data lives | Use it for |
| --- | --- | --- |
| `file` | One file per session, in `SESSION_FILES`. | Apps with sign-in on one server. |
| `database` | A row of the `sessions` table. | Apps with sign-in, several processes or servers. |
| `redis` | A key in Redis, which expires by itself. | Apps with sign-in that run Redis anyway. |
| `memory` | The process. Gone when it stops. | Tests. |

The `database` driver needs `@marmeon/database`, and the `redis` driver `@marmeon/redis`. A driver whose package is missing stops
the app at start-up with the command that installs it.

### The `database` driver

The table belongs to your app, and a command writes its migration:

```sh
pnpm marmeon make:session-table
pnpm marmeon migrate
```

The migration goes into the `system` module, or the module that `--module=<name>` names. It creates the table on the connection
`SESSION_CONNECTION` names.

The store writes through a connection of its own, never inside your app's transactions, so a session written while a transaction
is open survives its rollback. On Postgres it opens a small pool of its own. On SQLite, give the sessions a file of their own: the
app's own file has a single connection, and a session written inside a transaction there fails with an error that says so.

### Expiry and clean-up

The session cookie and the `XSRF-TOKEN` cookie are browser-session cookies: they carry no `Max-Age`, so the browser drops them
when it closes, and a guest's session data, such as a chosen language, goes with them. A browser that restores its tabs on start
may keep them; then the server's lifetimes below decide. A user who wants to stay signed in across a restart ticks "Keep me
signed in" ([remember me](authentication.md#remember-me)).

A session expires `SESSION_LIFETIME` minutes after its last request, whatever the cookie says. A sign-in also ends `AUTH_SESSION_MAX_HOURS` hours after it began, however active the user is; [how long a sign-in lasts](authentication.md#how-long-a-sign-in-lasts) lists every lifetime, and [sign-ins](authentication.md#sign-ins) lists the browsers a user is signed in on, with any session driver. Expired sessions of the `file` and `database` drivers are
deleted after the response of 2 in 100 requests, as `SESSION_LOTTERY` says. The `redis` driver needs no clean-up.

On a busy app, run the clean-up on a schedule instead. When the app's scheduler runs `session:prune`, requests stop drawing the
lottery by themselves:

```ts title="modules/system/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';

export const schedule = defineSchedule((s) => {
  s.command('session:prune').everyFifteenMinutes();
});
```

The module lists it as `schedule` in its definition. The [task scheduling](scheduling.md) page explains schedules.

## How sessions are stored

**Hashed keys.** The cookie carries the session's id, 240 random bits, encrypted like every cookie. The store sees only the id's
SHA-256 hash. Whoever reads the store, from a leaked backup or a shared Redis, gets keys that sign nobody in.

**Encryption.** With `SESSION_ENCRYPT=true`, the data in the store is encrypted with `APP_KEY` and bound to its key, so data
copied into another session's place does not open there. Keys in `APP_PREVIOUS_KEYS` still decrypt older data. It is off by
default: with hashed keys, the data alone signs nobody in. Turn it on when the store is shared, or backed up where the data should
not be read. Turning it on or off signs everybody out once.

**Concurrent requests.** A browser often has several requests of one session in flight, a page and its deferred props. Each write
compares the version the request read. When another request wrote the session in between, the store reads it again and applies
this request's changes key by key: what this request changed wins, everything else stays. Flash messages are merged by their ids,
so none is lost and none comes back. A request that keeps losing for 2 seconds saves nothing and logs a warning that names the
route.

What this does not do is add up. Two requests that read a counter and write it back plus one both write the same number. A route
that reads the session, decides and writes it back needs `block()`.

## What a session stores

A session is one JSON object. Next to your keys it holds the framework's own, whose names start with `_` (`_token`, `_flash`,
and `_auth_*` for a sign-in), and `_v`: the number of the format the object was written in, currently `1`. It is taken off when
the session is read, so `session.all()` does not list it. A `put('_v', …)` is replaced by the real mark when the session is written,
and the next request does not see it.

A session is read by its format, never guessed (the same rule holds for [every stored format](releases.md#stored-and-wire-formats)):

- **A newer format** is a session that a newer version of your app wrote while a rollout is under way. This version cannot know
  what its keys mean (one may restrict what the session may do), so it treats the request as one without a session cookie: a
  guest, and its CSRF token counts for nothing: a POST that only the token would let through gets a 419. What this request writes
  is not kept, so flash messages and form errors after a redirect do not appear, and no session cookie is sent. The newer session
  stays exactly as it is, until a request on this version signs in or out: that ends it, so a copy of its cookie does not outlive
  either, and the sign-in starts a new session under a new id.
- **No `_v`, or one that is not a whole number above zero** is a session of an older release or a broken record. It is dropped like
  a session that does not decrypt: a new session starts, and the old record expires with its lifetime (`session:prune`).

A restriction that a release adds belongs where the older format checks it as well: in the account's fingerprint or the sign-in
row, not only in a session key. An older node ignores a key it does not know. If the restriction can only be a session key, the
release that sets it must also delete the remember-me token of that device; otherwise remember-me signs the user in on an older
node without the restriction.

## Requests that must not overlap

`.block()` on a route runs its requests one at a time per session. `StartSession` takes a lock on the session before it reads it
and frees it after saving it:

```ts title="modules/notes/routes.ts"
import { authenticate } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { CheckoutController } from './controllers/CheckoutController.ts';
import { WizardStepController } from './controllers/WizardStepController.ts';

export default defineRoutes((Route) => {
  const signedIn = Route.middleware(authenticate()).authorize(everyone); // the user's own cart
  signedIn.post('/notes/checkout', CheckoutController).name('notes.checkout').block();
  signedIn.post('/notes/wizard', WizardStepController).name('notes.wizard').block(5, 2);
});
```

`block(lockSeconds, waitSeconds)` holds the lock for at most `lockSeconds`, 10 by default, and waits at most `waitSeconds` for it,
by default as long. A request that waits longer answers 423 with `Retry-After`. A request without a session cookie locks nothing.
The lock needs the cache's atomic locks: without `@marmeon/cache`, the route fails with an error that says so. The starter kit
blocks the password change and "sign out other devices".

## Signing out while requests run

A request that started before a sign-out finishes after it, with the session as it was: still signed in. With the `file`,
`database`, `redis` and `memory` drivers, it cannot bring that session back. Its write finds the session destroyed, saves
nothing and sends no cookie, so the browser keeps the cookie of the sign-out.

`UserSessions` ends every session of one user at once, which deleting an account needs. The
[authentication](authentication.md#ending-every-session-of-a-user) page covers it.

### When a session ends

Code that holds something for a session, such as an open live stream, must let go when the session ends. `SessionEndings` of
`@marmeon/session` tells it, once the request that signed in or out has saved the session:

```ts title="modules/notes/NotesServiceProvider.ts"
import type { Application, ServiceProvider } from '@marmeon/core';
import { SessionEndings } from '@marmeon/session';
import { NoteDrafts } from './NoteDrafts.ts';

export class NotesServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    const drafts = app.container.make(NoteDrafts);
    app.container.make(SessionEndings).listen((scope) => drafts.forget(scope));
  }
}
```

A listener gets the old session's scope, a hash of its id, never the id itself, which is a secret. A listener that fails does not
stop the others. `listen()` returns a function that stops listening, for a provider's `shutdown()`. The live updates of the
framework close the streams of an ended session this way, in every process.

## Requests that only read

An island, a live stream and an upload read the session but never write it. Nothing they do is saved, they set no cookie, and flash
data stays for the page. A write there throws in development and in tests, and is logged and dropped everywhere else. The
[request lifecycle](lifecycle.md#requests-that-only-read) page lists every such request.

## A store of your own

A store implements `SessionStore` of `@marmeon/session`:

```ts
interface SessionStore {
  read(key: string): Promise<{ data: string; version: number } | undefined>;
  write(key: string, data: string, options: { expectedVersion: number | undefined; lifetimeSeconds: number; userId?: string | null }): Promise<'written' | 'conflict' | 'gone'>;
  destroy(key: string): Promise<void>;
  gc(lifetimeSeconds: number): Promise<number>;
  destroyUser?(userId: string): Promise<number>;
}
```

`key` is the hash of the session's id and `data` is opaque text: keep both as they are. A write with `expectedVersion: undefined`
creates the key at version 1, and answers `conflict` when something is stored under it already. A write with a number replaces
exactly that version: `conflict` when the stored version differs, `gone` when there is none. Compare and write in one atomic step.
`destroyUser` is optional and ends every session of a user.

## Testing

`.env.test` of a new app sets `SESSION_DRIVER=memory`. A test can start with session data, and assert what a request left in it:

```ts title="modules/notes/session.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteRepository } from './NoteRepository.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('remembers the notes a visitor opened', async () => {
  const ada = await app.factory(UserFactory).create();
  const note = await app.make(NoteRepository).insert({ user_id: ada.id, title: 'Draft', body: '' });
  await app.actingAs(ada).withSession({ recentNotes: [42] }).get(`/notes/${note.id}`).assertOk().assertSessionHas('recentNotes', [note.id, 42]);
});
```

`assertSessionMissing(key)` checks that a key is gone. The [HTTP tests](http-tests.md#sessions-and-signing-in) page covers sessions, signing in and flash messages.
