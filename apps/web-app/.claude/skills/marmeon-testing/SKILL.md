---
name: marmeon-testing
description: Write tests in a Marmeon app — a feature test over the booted app with createTestApp(), a refreshed database and factories, the fakes for mail, queue, notifications and storage, an allowed and a refused request for every route, pages and islands, the clock, and type guarantees in a *.type-test.ts file. Use it whenever you add or change a route, a controller, a policy, a job or a module and need its test, or when a test fails.
metadata:
  marmeon-skill: "1"
---
<!-- Managed by marmeon agents:install — edits are replaced; copy the folder under another name to keep your own. -->

In this skill, `docs/<page>.md` means `node_modules/marmeon/docs/<page>.md`, the guide of the installed version.

# Write tests

A feature test boots the app and sends requests through its real kernel, with a database of its own and fakes in place of mail,
the queue, notifications and storage. `@marmeon/testing` and `vitest` are in a new app. Read `marmeon docs testing`
(`node_modules/marmeon/docs/testing.md`) for anything below that is not clear.

## Where tests live and how they run

```sh
pnpm exec marmeon make:test checkout --module=shop --path=/shop   # modules/shop/checkout.test.ts
pnpm test                 # every modules/**/*.test.ts, once
pnpm test modules/shop    # the tests of one module
```

- The generated test expects `--path` to answer 200 and fails until the route exists: change it to what you test.
- Vitest sets `NODE_ENV=test`, and `.env.test` is read on top of `.env`: sessions and the cache in memory, mail `array`, hashing
  at a tiny cost, no logs (`docs/testing.md#the-test-environment`). Put a value a test needs there or in the `env` option of
  `createTestApp()`; never a real secret, and never read `.env` in a test.
- A route a test registers for itself must say who may call it, as any route does (`Route.authorize(everyone)`).

## The test app

```ts
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});
```

- The examples assume the starter kit's `auth` module for users: `UserFactory`, `actingAs()` and the sign-in page `/login`. An app made with
  `--minimal` gets it from `marmeon make:auth` (`docs/starter-kit.md`); without it, write a factory for your own users table and sign in as one of its rows.
- `database: 'refresh'` gives each test an empty, migrated database; everything a test writes is rolled back when it ends. Only
  one test app with a database may be open at a time. Only the `default` connection is reset (`docs/database-testing.md#how-the-database-is-reset`).
- An app made in a test or in `beforeEach` closes itself; in `beforeAll` call `await app.close()` in `afterAll` (`docs/testing.md#closing-the-app`).
- Make rows with factories, not by hand: `await app.factory(UserFactory).create()`, `.count(3).create({ user_id: ada.id })`,
  `.state('name')` (`docs/database-testing.md#factories`). `marmeon make:factory <Name> --module=<module>` writes `factories/<Name>Factory.ts` for the plural table (`--table=<t>` names another); it does not check the table, and the file compiles once `bootstrap/database.d.ts` declares it and the factory fills the table's NOT NULL columns without a default (the compiler lists the missing ones). `seed: true` runs the
  seeders before every test; prefer factories.
- Replace one service for a test with `override: (container) => container.instance(Service, double)` (`docs/testing.md#replacing-services`).
- `app.make(NoteRepository)` is the repository the controllers use. Check rows with `await app.assertDatabaseHas('notes', { … })`,
  `assertDatabaseMissing` and `assertDatabaseCount` (`docs/database-testing.md#database-assertions`).
- Run a console command with `await app.command('cache:clear')`; it resolves with `code` and `lines` (`docs/testing.md#running-commands`).

## Every route gets an allowed and a refused request

For each route, write one request that must succeed and at least one that must be refused. A route nobody tested for a refusal is
a route nobody knows is closed. A route open to `everyone` (a public page, sign-in, a contact form) has no refused caller: test its
refused input instead where it validates any (`assertInvalid`), and its throttle if it has one; a public page without input needs
only its allowed request.

```ts
// UserFactory from '#modules/auth', NoteFactory from './factories/NoteFactory.ts'
it('lets the author edit a note and refuses anyone else', async () => {
  const [ada, alan] = await app.factory(UserFactory).count(2).create();
  const note = await app.factory(NoteFactory).create({ user_id: ada!.id, title: 'Draft' });

  await app.get(`/notes/${note.id}/edit`).assertRedirect('/login'); // a guest
  await app.actingAs(alan!).get(`/notes/${note.id}/edit`).assertNotFound(); // a stranger: the policy denies as not found
  await app.actingAs(alan!).put(`/notes/${note.id}`, { form: { title: 'Mine now' } }).assertNotFound();
  await app.assertDatabaseHas('notes', { id: note.id, title: 'Draft' }); // the refused change left the row alone
  await app.actingAs(ada!).put(`/notes/${note.id}`, { form: { title: 'Final' } }).assertRedirect('/notes');
  await app.assertDatabaseHas('notes', { id: note.id, title: 'Final' });
});
```

- The refusal depends on the route: a guest is sent to the sign-in page (or gets `assertUnauthorized()` on a JSON request, see
  `expectingJson()`), a user the policy refuses gets `assertForbidden()` or, for a record that is nobody else's business, `assertNotFound()`
  (`docs/authorization.md#testing`). Read the policy to know which, and assert that status, not just "not 200".
- Check the data too: after a refused change the row is unchanged.
- An API route with a token: `actingAs(user, { guard: 'api', abilities: ['notes:read'] })` (`docs/http-tests.md#sessions-and-signing-in`).
- The `routes` MCP tool, or `marmeon route:list`, lists every route with its access: walk the list and match each line to a test. The tool returns at most 200 routes by
  default: read `truncated`, and narrow with `path`, `name` or `method`, raise `limit`, or use `marmeon route:list` for the whole list.

## Requests and assertions

- `app.get()`, `post()`, `put()`, `patch()`, `delete()` take `{ form }`, `{ json }`, `{ multipart }` or `{ headers }`. Nothing runs until you
  `await` the chain, so always `await` it (`docs/http-tests.md#making-requests`).
- `actingAs(user)` signs in; `keepingCookies()` is a browser that keeps its session across requests, for a real sign-in flow
  (`docs/http-tests.md#sessions-and-signing-in`).
- Status: `assertOk()`, `assertRedirect(location)`, `assertForbidden()`, `assertNotFound()`, `assertUnprocessable()`, `assertStatus(n)`.
  Validation: `assertInvalid(['title'])`. Flash: `assertFlashed()`, `assertFlash()` (`docs/http-tests.md#assertions`).
- A test app does not check CSRF, unless it runs as production (`env: { NODE_ENV: 'production' }`). To test the check, pass `csrf: true` and send what a browser sends, for example
  `headers: { 'sec-fetch-site': 'cross-site' }` for a refusal (`docs/http-tests.md#csrf-protection-in-tests`). Never add `csrfExcept` to make a test pass.
- A failed assertion prints the request, the status and the start of the body. For an unexpected 500, create the app with `debug: true`.

## Fakes

Four fakes are on by default as soon as the app has the package: `app.mail`, `app.queue`, `app.notifications` and `app.storage`
(`docs/fakes.md`). Those services never send, queue for real or write to disk.
Nothing else is replaced: your own HTTP client or another provider SDK still reaches the real service, so replace it in the test with
`override` (`docs/testing.md#replacing-services`), and a Postgres test still needs its database server.
`app.events` is not a fake: it records every event, and the listeners still run. `app.schedule` runs the real schedule on the test's
clock and needs `@marmeon/scheduler`.

- Mail: `app.mail.assertSent(Mail)` or `assertQueued(Mail)`. A mail sent from a queued listener exists only after `await app.queue.work()` (`docs/fakes.md#mail`).
- Queue: `app.queue.assertDispatched(Job, { part of payload })`, then `await app.queue.work()` runs the jobs for real (`docs/fakes.md#queue`).
- Notifications: `app.notifications.assertSent({ type: 'user', id }, Notification)`; `deliver()` delivers them (`docs/fakes.md#notifications`).
- Files: the storage fake keeps every disk in memory, so a test never makes a temporary folder. `app.storage.disk('local').assertExists(key)`,
  `assertMissing(key)`, `assertCount(n, directory)`. `app.upload(routeName, field, file)` sends a file through the route's real
  upload target (`docs/fakes.md#storage`, `docs/http-tests.md#uploads`). `storage: 'real'` writes to real disks; do not use it.
- Events: `app.events.assertDispatched(Event)`; `events: [Event]` holds back the listeners of that event (`docs/fakes.md#events`).
- Time: `app.freeze(Date.parse('2026-10-04T12:00:00Z'))`, `app.travel({ minutes: 5 })`, `app.travelTo(date)`. Never `Date.now()` or a sleep
  in a test (`docs/time.md#moving-the-clock`). `app.schedule.run(time)` runs the tasks due at a time (`docs/fakes.md#the-schedule`).

## Pages and islands

Send a client-side visit with `navigating()` and assert the page and its props, typed by the controller:

```ts
await app.actingAs(ada).navigating().get('/notes').assertPage<ListNotesController>('notes/ListNotes', (props) => {
  expect(props.notes.data).toHaveLength(2);
});
```

- An island has its own route: `app.actingAs(ada).island('notes.recent').assertIsland<ShowRecentNotesController>('notes/RecentNotes', …)`, and
  `app.island('notes.recent').assertIslandStatus('unauthorized')` for a guest (`docs/testing-pages.md#islands`). Test the island's refusal like any route.
- A test does not render in a browser. `ssr: true` renders on the server (`docs/testing-pages.md#server-rendering`).

## Type guarantees

A promise made by a type (a form field that must not compile, a key that must be refused) is tested in a `*.type-test.ts` file next to
the module. `@ts-expect-error` marks the line that must fail; if it ever compiles, the type check fails on the unused directive.

```ts
// modules/notes/notes.type-test.ts — compiled by tsc, never run
import type { Row } from '@marmeon/database';

export type Title = Row<'notes'>['title']; // fine

// @ts-expect-error — the notes table has no column "secret"
export type Wrong = Row<'notes'>['secret'];
```

Vitest never runs these files (`include` is `modules/**/*.test.ts`); `tsc --noEmit` compiles them, because a new app's `tsconfig.json`
includes `modules`. `marmeon check` runs that type check as its `types` check (`docs/check.md#the-checks`, `docs/localization.md#testing`).

## Before you hand the change back

1. `pnpm test modules/<module>` is green, and a test fails without the change you made: break the code once and watch it go red.
2. Every new route has an allowed and a refused test (a route open to `everyone`: its refused input); every new job, mail or notification is asserted on its fake.
3. `marmeon check` is green (or its `check` MCP tool; `only: ["types", "lint"]` is the quick round). Do not silence a finding to get there.
