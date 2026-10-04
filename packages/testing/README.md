# @bespokecore/testing

Feature tests for BespokeCore apps, in Laravel's manner: `createTestApp()` boots the real application from its definition and
sends requests through the real HTTP kernel — middleware, sessions, controllers, views — without a server or a port. A
refreshed database per test, fakes for mail, the queue, notifications and storage, a movable clock, and chainable assertions
for pages, islands, layers, actions, flash messages and validation. It runs under Vitest.

```sh
pnpm add -D @bespokecore/testing vitest
```

A dev dependency with no provider: nothing to discover, tests import it. The other framework packages are optional peers —
`createTestApp` wires what the app has installed. Vitest runs with the app's Vite plugin (`bespoke({ test: true })` in
`vitest.config.ts`, [@bespokecore/vite](../vite/README.md)) and sets `NODE_ENV=test`.

```ts
// modules/auth/auth.test.ts
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

describe('signing in and out', () => {
  it('signs out', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/logout').assertRedirect('/login').assertGuest();
    await app.expectingJson().get('/dashboard').assertUnauthorized();
  });
});
```

## `createTestApp(App, options)`

Boots a fresh application from its definition (the default export of `bootstrap/app.ts`) for every call. Inside a Vitest test
or its `beforeEach` the app closes when the test ends — its database transaction rolled back, its connections closed;
elsewhere `await app.close()` or `await using app = await createTestApp(…)`. Closing waits for the app's `terminate` hooks.

| Option | Default | |
|---|---|---|
| `env` | — | variables on top of the app's environment (`undefined` removes one: `{ APP_URL: undefined }`) |
| `override` | — | `(container) => …` — replace bindings before the boot; even singletons see them |
| `csrf` | `false` | verify CSRF tokens — then send `_token` or the header yourself |
| `database` | — | `'refresh'`: a migrated database per test worker, each test in one transaction — [below](#the-database) |
| `seed` | `false` | with `database: 'refresh'`: run the modules' seeders for every test |
| `mail` | `'fake'` | `MailFake` as the `Mailer` (`app.mail`); `'real'` keeps the configured transport |
| `queue` | `'fake'` | `QueueFake` as the `Queue` (`app.queue`); `'real'` keeps `QUEUE_CONNECTION` |
| `notifications` | `'fake'` | `NotificationFake` (`app.notifications`); `'real'` keeps the real one |
| `storage` | `'fake'` | every configured disk in memory (`app.storage`); `'real'` keeps the configured disks |
| `events` | `'real'` | every event is recorded (`app.events`); `'fake'` runs no listener, `[Registered, Login]` holds back only those |
| `ssr` | `false` | render pages on the server through the app's Vite setup; `'stream'` as for a browser — [server rendering](#server-rendering) |
| `debug` | `false` | development error handling (E119): the error page for 5xx pages, `exception` and `solution` in JSON errors |
| `devtools` | `false` | record what the app does into memory (`app.devtools`) — the only way outside `NODE_ENV=development` |

**The environment** is `.env`, then `.env.test` (for `NODE_ENV=test`), then the process environment, then `options.env` — and
with `database: 'refresh'` the worker database's connection on top. A definition with its own `env` (a fixture app) skips the
files. The devtools stay off in every test that does not pass `devtools: true` (`DEVTOOLS_ENABLED=false`), also one that runs
as development (`env: { NODE_ENV: 'development' }`).

**Always in place:** a `TestClock` as the app's `Clock`, an `EventFake` that records every dispatch, and — with
`@bespokecore/live` — a `BroadcastRecorder` (`app.broadcast`). The app itself is `app.application`, its container
`app.container`; `app.make(UserRepository)` resolves a service.

### `.env.test`

```sh
# apps/web-app/.env.test — loaded on top of .env when NODE_ENV=test
APP_KEY=base64:…                 # a fixed key for tests only
SESSION_DRIVER=memory            # session helpers need a server-side driver
CACHE_DRIVER=memory
DB_DATABASE=:memory:
LOG_LEVEL=silent
HASH_ARGON_MEMORY=1024           # cheap hashing: tests check behaviour, not strength
HASH_ARGON_TIME=1
MAIL_MAILER=array
```

## Requests

```ts
await app.get('/users/1').assertOk().assertPage('user-profile/Show');
await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect('/dashboard');
const response = await app.put(`/users/${ada.id}`, { json: { name: 'Ada', bio: '' } });
```

`get`, `post`, `put`, `patch`, `delete` and `request(method, path, options)` take `{ headers, form, multipart, json, body }`
(`form` as an HTML form sends it, `multipart` with `File`s, `body` as it is). They return a `PendingTestResponse`: the
assertions chained onto it run when it is awaited, and the awaited value is the `TestResponse` (`status`, `headers`, `body`,
`json()`, `page()`, `cookie(name)` decrypted, `session()`). Every request waits for the app's `terminate` hooks before it
resolves.

Each of these returns a new view of the same app with defaults for its requests:

| | |
|---|---|
| `withHeaders(headers)`, `expectingJson()` | headers; `Accept: application/json` |
| `withCookie(name, value)`, `withUnencryptedCookie(name, value)` | a cookie encrypted as the app encrypts its own — or exactly as given |
| `withSession(data)` | a session holding `data` before the request |
| `actingAs(user)`, `actingAs(user, { guard: 'api', abilities? })` | signed in, as a login leaves the session — or with a real API token ([@bespokecore/auth](../auth/README.md#testing)) |
| `navigating()` | a client-side visit: answered with the page object as JSON |
| `prefetching()` | a prefetch (`<Link prefetch>`, `Purpose: prefetch`) |
| `reloading<C>(component, { only?, except? })` | a partial reload of the page on screen — `only` typed by controller `C` |
| `islanding()`, `island(name, params?, query?)` | an `<Island route>`'s request (E48) — `island()` by route name |
| `layering()`, `layer(name, params?, query?)` | a request of a layer (E53) — `layer()` opens one by route name |
| `acting()` | an action (`useAction`, E59) |
| `validating(...fields)` | a live validation of those fields (E62) — the controller never runs |

A view made by `withSession` or `actingAs` keeps one session id across its requests, like one browser. To carry on with the
session a response started, send its cookie: `app.withCookie('bespoke_session', login.cookie('bespoke_session')!)`.

```ts
await app.actingAs(ada).reloading<ShowUserProfileController>('user-profile/Show', { only: ['stats'] }).get(`/users/${ada.id}`).assertOk();
await app.actingAs(ada).island('dashboard.sign-ins', {}, { range: '7d' })
  .assertIsland<ShowRecentSignInsController>('dashboard/RecentSignIns', { entries: [] });
await app.actingAs(ada).acting().post(`/users/${ada.id}/links`, { json })
  .assertActionRedirect(`/users/${ada.id}`).assertFlash('toast', { message: 'Link added.' });
await app.validating('name', 'email').post('/register', { json: registration }).assertLiveValid('name', 'email');
await app.actingAs(ada).layer('auth.tokens.create').assertOk().assertLayer('auth/CreateAccessToken');
```

- **`await app.upload(routeName, field, file, params?)`** sends a file as the browser does — the route's upload target, then the
  bytes — and returns the token the form sends in the field (the view's session owns it). Uploads land on the storage fake.
- **`await app.live(path)`** opens the live stream of the page at `path` as a tab does
  ([@bespokecore/live](../live/README.md#testing)); **`await app.stream(path)`** returns the raw `Response` with its body unread.

## Assertions

| | |
|---|---|
| Status | `assertStatus(n)`, `assertOk()`, `assertSuccessful()`, `assertCreated()`, `assertNoContent()`, `assertUnauthorized()`, `assertForbidden()`, `assertNotFound()`, `assertUnprocessable()`, `assertRedirect(location?)` |
| Pages | `assertPage<C>(component, props?)` — props a deep subset or a callback, typed by controller `C`; `page()` |
| Islands | `assertIsland<C>(component, props?)`, `assertIslandStatus('unauthorized' \| 'forbidden' \| 'exception')`; `island()` |
| Layers | `assertLayer<C>(component, props?)`, `assertLayerClosed({ layers?, reload? })`; `layers()` |
| Actions | `assertActionRedirect(url?)` — `204` with `x-bespoke-redirect` |
| Validation | `assertInvalid<C>(['name'])` or `assertInvalid<C>({ email: /taken/ })` — from a 422 or the errors flashed to the session; `assertValid()`, `assertLiveValid(...fields)` |
| Flash messages (E60) | `assertFlash(key, data?)` — this answer delivers it; `assertFlashed(key, data?)` — waiting in the session (a redirect); `assertNoFlash(key?)`; `flash()`, `flashed()` — keys and data typed by the app's `FlashData` |
| Session and sign-in | `assertSessionHas(key, value?)`, `assertSessionMissing(key)`, `assertAuthenticated(user?)`, `assertGuest()` |
| Cookies | `assertCookie(name, value?)`, `assertCookieMissing(name)`, `assertCookieExpired(name)` — values decrypted |
| Headers and body | `assertHeader(name, value?)`, `assertJson(subset)`, `assertExactJson(value)`, `assertSee(text)`, `assertDontSee(text)` |
| Server rendering | `assertServerRendered()`, `assertHydrates()` |

A failed assertion says what it expected and shows the request, the status and the start of the body.

## The database

```ts
const app = await createTestApp(application, { database: 'refresh' });
const ada = await app.factory(UserFactory).create();
const users = await app.factory(UserFactory).count(3).create();
await app.assertDatabaseHas('profile_links', { user_id: ada.id, label: 'Blog' });
await app.assertDatabaseMissing('users', { email: 'ada@example.com' });
await app.assertDatabaseCount('users', 4);
```

`database: 'refresh'` is Laravel's `RefreshDatabase` (E21): each test worker (`VITEST_POOL_ID`) gets a database of its own —
a SQLite file in the system's temporary directory, or on Postgres `<database>_test_<hash of the app's root>_<worker>`, dropped and created from
the configured `DB_URL` — migrated once per process. Every refreshed test app then runs inside one transaction that is
rolled back when the test ends: each test starts empty, and the app's own transactions become savepoints in it
([transactions](../database/README.md#transactions)). Only one refreshed app may be open at a time. The database assertions
are typed by the table and, when they fail, show what the table holds. Needs `@bespokecore/database`.

## Fakes

The fakes belong to their packages; `createTestApp` puts each in place when the app has the package (and the test did not
choose `'real'`), and the getter says what is missing otherwise.

| | Replaces | Assertions |
|---|---|---|
| `app.mail` | `Mailer` → `MailFake` | [@bespokecore/mail](../mail/README.md#testing) |
| `app.queue` | `Queue` → `QueueFake`; `await app.queue.work()` runs the jobs | [@bespokecore/queue](../queue/README.md#testing) |
| `app.notifications` | `Notifications` → `NotificationFake` | [@bespokecore/notifications](../notifications/README.md#testing) |
| `app.storage` | `Storage` → `StorageFake`, every disk in memory | [@bespokecore/storage](../storage/README.md#testing) |
| `app.broadcast`, `app.live()` | records what the `Broadcaster` sent | [@bespokecore/live](../live/README.md#testing) |
| `app.schedule` | runs the schedule with the test clock | [@bespokecore/scheduler](../scheduler/README.md#testing) |
| `app.devtools` | with `devtools: true` | [@bespokecore/devtools](../devtools/README.md#tests) |
| `app.events` | records every dispatch (`EventFake` of `@bespokecore/core`) | below |

```ts
app.events.assertDispatched(Registered, (event) => event.user.id === ada.id);
app.events.assertDispatched(Login, { remember: true, via: 'attempt' });         // or a subset of its fields
app.events.assertDispatchedTimes(Login, 1).assertNotDispatched(Logout);
app.events.assertNothingDispatched();
app.events.assertListening(Registered, SendEmailVerification);                  // registered with listen() — queued or not
app.events.dispatched(Login);                                                   // the events themselves
```

Listeners run as usual unless the test holds them back: `events: 'fake'` (none) or `events: [Registered]` (those and their
subclasses). Queued listeners land on the `QueueFake` (`app.queue.assertListenerQueued(…)`).

## Time

Every test app has a `TestClock` as its `Clock` (E97) — whatever reads the time through it (cache expiry, locks, rate limits,
signed URLs, token expiry, the scheduler) sees it move:

```ts
app.freeze(Date.parse('2026-10-04T12:00:00Z'));   // stops the time (now, or at a time)
app.travel({ minutes: 61 });                       // forward (negative parts: back)
app.travelTo(new Date('2026-12-24T18:00:00Z'));
app.clock.unfreeze();
```

Redis keeps its own time: a key's `PX` expiry does not follow.

## Server rendering

With `ssr: true` pages render on the server through the app's `vite.config.ts`, as `bespoke dev` renders them — completely,
islands included, as for a bot (E49) — so markup and `<Head>` are testable:

```ts
const app = await createTestApp(application, { database: 'refresh', ssr: true });
await app.actingAs(ada).get('/dashboard', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates();
```

`assertServerRendered()` fails with the render's error; `assertHydrates()` renders the page again from the JSON the browser
receives and compares the markup (a `Date` prop rendered on the server but sent as a string fails here). `ssr: 'stream'`
answers as for a browser — the shell first, islands and deferred props streamed into the same response; read it as it
arrives with `app.stream(path)`. Without `ssr` a response carries the page object only (fast, no Vite).

## The framework's own suites: Postgres, Redis, S3

In this repository `pnpm test` runs every package's tests and the web app's on SQLite and in memory. The cases for other
backends run when their variable is set — the services come from `compose.yaml` (`docker compose up -d`, own ports):

```sh
pnpm test:pgsql   # BESPOKE_TEST_PGSQL_URL, DB_CONNECTION=pgsql and DB_URL → postgres://bespoke:secret@localhost:55432/bespoke
pnpm test:redis   # BESPOKE_TEST_REDIS_URL=redis://127.0.0.1:56379
pnpm test:s3      # BESPOKE_TEST_S3_ENDPOINT=http://127.0.0.1:56333 — packages/storage only
                  # (BESPOKE_TEST_S3_KEY / BESPOKE_TEST_S3_SECRET default to the compose identity)
```

With `DB_CONNECTION=pgsql` and `DB_URL` in the environment, refreshed test apps of any app use Postgres: the role needs the
right to create databases (one per worker, next to the configured one).
