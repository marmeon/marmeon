# Getting Started

## Introduction

A feature test boots your real application and sends requests through its real HTTP kernel: the middleware, the session, the
controller and the page all run as they do for a browser, without a server and without a port. `@marmeon/testing` builds that test
app, gives it a fresh database for every test that asks for one, puts fakes in place of mail, the queue, notifications and
storage, and adds assertions for pages, redirects, validation and flash messages. The tests run under
[Vitest](https://vitest.dev).

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

it('shows the notes to a signed-in user', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).navigating().get('/notes').assertOk().assertPage('notes/Index');
  await app.get('/notes').assertRedirect('/login');
});
```

`application` is the default export of `bootstrap/app.ts`, the same definition `marmeon dev` and `marmeon start` boot.
`createTestApp()` boots a new app from it for every call, so tests never share state.

## Running tests

A new app comes with its test setup. `@marmeon/testing` and `vitest` are dev dependencies, and `vitest.config.ts` uses the app's
Vite plugin in its test mode:

```ts title="vitest.config.ts"
import { marmeon } from '@marmeon/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [marmeon({ test: true })],
  test: { include: ['modules/**/*.test.ts'] },
});
```

`pnpm test` runs every `*.test.ts` file under `modules/`, once. Pass a path to run some of them, and run Vitest itself to keep it
watching:

```sh
pnpm test                 # every test, once
pnpm test modules/notes   # the tests of one module
pnpm vitest               # watch mode: runs the tests again when a file changes
```

Vitest sets `NODE_ENV=test`. The [asset bundling](vite.md#tests) page explains what the plugin does in its test mode.

## The test environment

A test app reads its environment in this order, each source over the one before:

1. `.env`, the app's own file.
2. `.env.test`, the file for `NODE_ENV=test`. A `NODE_ENV` line in it is ignored.
3. The process environment.
4. The `env` option of `createTestApp()`.
5. With `database: 'refresh'`, the connection of the test's own database.

A new app's `.env.test` holds what tests need, and nothing secret:

```sh title=".env.test"
# Loaded on top of .env when NODE_ENV=test (Vitest sets it).
APP_NAME="Notes (test)"
APP_URL=http://localhost
# A fixed key for tests only — never use it anywhere else.
APP_KEY=base64:…
SESSION_DRIVER=memory
CACHE_DRIVER=memory
DB_DATABASE=:memory:
LOG_LEVEL=silent
HASH_ARGON_MEMORY_KB=1024
HASH_ARGON_TIME=1
MAIL_DRIVER=array
```

`create-marmeon` writes a key of its own into this file, for tests only. Sessions and the cache live in memory, and nothing is
logged. Password hashing runs at a tiny cost, because tests check behaviour and not strength. A test that does not ask for a
refreshed database gets an empty in-memory SQLite database without tables.

### Which environment a test runs in

Every test app runs as `NODE_ENV=test` unless its environment names another value. Under Vitest the process's `NODE_ENV=test` wins
over a `NODE_ENV=development` in `.env`. A script that calls `createTestApp()` outside Vitest takes the value of `.env`. Pass
another value to test behaviour that depends on it:

```ts title="modules/notes/environment.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('has the mail previews in development only', async () => {
  const test = await createTestApp(application);
  await test.get('/_marmeon/mail').assertNotFound();
  const development = await createTestApp(application, { env: { NODE_ENV: 'development' } });
  await development.get('/_marmeon/mail').assertOk();
});
```

With `NODE_ENV=development` the app turns on what only development has, such as the mail previews and the `Server-Timing`
header. With `NODE_ENV=production` it applies every protection, as it does on a server. The devtools stay off in every test that
does not pass `devtools: true`, also in one that runs as development. The
[configuration](configuration.md#the-environment-node_env) page explains the two rules behind `NODE_ENV`.

## Creating the test app

`createTestApp(application, options)` takes these options:

| Option | Default | Effect |
| --- | --- | --- |
| `env` | none | Variables on top of the app's environment. `undefined` removes one: `{ APP_URL: undefined }`. |
| `override` | none | `(container) => …` replaces bindings before the app boots. Even singletons see the replacement. |
| `database` | none | `'refresh'`: a migrated database for each test worker, and each test in a transaction that is rolled back. |
| `seed` | `false` | With `database: 'refresh'`, runs the modules' seeders for every test. |
| `csrf` | `false` | `true` checks requests for CSRF as the app does. |
| `mail` | `'fake'` | `'real'` keeps the configured mailer instead of the fake. |
| `queue` | `'fake'` | `'real'` keeps the configured queue connection instead of the fake. |
| `notifications` | `'fake'` | `'real'` keeps the real notification service instead of the fake. |
| `storage` | `'fake'` | `'real'` keeps the configured disks instead of disks in memory. |
| `events` | `'real'` | Every event is recorded. `'fake'` runs no listener, and a list of event classes holds back only theirs. |
| `ssr` | `false` | `true` renders pages on the server through the app's Vite setup. `'stream'` streams them as for a browser. |
| `ssrServer` | none | A Vite server from `startSsrServer()`, shared by the test apps of a file ([one Vite server per file](testing-pages.md#one-vite-server-per-file)). Needs `ssr`. |
| `debug` | `false` | `true` turns on the development error handling for this test app. |
| `devtools` | `false` | `true` records what the app does into memory, readable as `app.devtools`. |

`marmeon make:test checkout --module=shop --path=/shop` writes `modules/shop/checkout.test.ts`: a test with this setup that expects `/shop` to answer 200. It fails until the route does, so change it to what you test. It needs `@marmeon/testing` and `vitest` in the app.

A fake is put in place only when the app has its package. `seed: true` without `database: 'refresh'` stops the test:

```text
createTestApp(…, { seed: true }) seeds a refreshed database: add database: 'refresh'.
```

The [database testing](database-testing.md) page covers the database, the [fakes](fakes.md) page the fakes, and the
[testing pages](testing-pages.md) page server rendering.

A test app checks its routes as the real app does. A route that a test registers for itself has to say who may call it as well,
most simply with `Route.authorize(everyone)`; a route without a decision stops `createTestApp()` with the report that names the
file and line. See [every route decides](authorization.md#every-route-decides).

### What every test app has

Besides what the options add, every test app has:

- a test clock as the app's `Clock`, which `app.travel()` and `app.freeze()` move, as the [time](time.md) page shows;
- `app.events`, which records every event the app dispatches;
- `app.broadcast`, which records every live hint, when the app has `@marmeon/live`.

`app.application` is the booted application, `app.container` its container, and `app.make(Service)` resolves a service from it.
`app.make(NoteRepository)` hands you the same repository the controllers use.

### Your own kernel

The requests of the test app (`app.get()`, `app.post()`, …) wait for the work scheduled after a response. A test that sends requests
itself, such as a fake browser over `fetch(request)`, builds a kernel of its own from the booted application:

```ts
import { createHttpKernel } from '@marmeon/server';

const kernel = createHttpKernel(app.application);
const response = await kernel.request('/whoami');
```

`createHttpKernel(application, options)` takes `KernelOptions`, among them `maxBodyBytes` for a request body under 1 MB
(the [requests](requests.md) page has `SERVER_MAX_BODY_MB` for everything above). The kernel builds on the application's
container, so it sees the test app's fakes. A request has no peer address unless you give one as the last argument, which then goes
through `SERVER_TRUSTED_PROXIES` like a real socket's:

```ts
const response = await kernel.request('/whoami', { headers: { 'x-forwarded-for': '198.51.100.7' } }, { remoteAddress: '10.1.2.3' });
```

## Closing the app

A test app made inside a Vitest test, or in its `beforeEach`, closes by itself when the test ends. Its database transaction is
rolled back and its connections are closed. This is the usual way:

```ts title="modules/notes/list.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('lists no notes for a new user', async () => {
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).navigating().get('/notes').assertOk().assertPage('notes/Index');
});
```

An app made anywhere else stays open until you close it: in `beforeAll`, call `await app.close()` in `afterAll`, and in a plain
function write `await using app = await createTestApp(application)`. Closing waits for the work the app still does after its
responses, then shuts the app down.

## Replacing services

`override` binds your own service in place of the app's, before any provider boots. It is an option of `createTestApp()`, not
of `defineApplication()`: the app's definition cannot carry test doubles, so none can reach production.

```ts title="modules/notes/search.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteSearch } from './NoteSearch.ts';

it('shows an empty search', async () => {
  const app = await createTestApp(application, {
    database: 'refresh',
    override: (container) => container.instance(NoteSearch, { search: async () => [] }),
  });
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).navigating().get('/notes/search?q=milk').assertOk().assertPage('notes/Search', { results: [] });
});
```

The [service providers](providers.md#testing) page explains when a replacement takes effect.

## Errors in tests

A test app answers errors as production does: a page request that fails gets the plain error page, and a JSON request gets the
short message. `debug: true` turns on the development error handling for one test app: the development error page for a page
request that fails with a 5xx, and the exception and a solution in JSON errors. It shows what went wrong when a test fails with a
500 you did not expect. The [error handling](errors.md#the-development-error-page) page shows what the development error page
contains.

## Next steps

- [HTTP tests](http-tests.md): requests, sessions, signing in and every assertion.
- [Database testing](database-testing.md): the refreshed database, factories and database assertions.
- [Fakes](fakes.md): mail, the queue, notifications, storage, events, live hints and the schedule.
- [Time](time.md): moving the app's clock.
- [Testing pages](testing-pages.md): pages, islands, layers and server rendering.
