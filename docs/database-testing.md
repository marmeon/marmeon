# Database Testing

## Introduction

`createTestApp(application, { database: 'refresh' })` gives every test a real, migrated database that starts empty. The test
fills it with factories, sends its requests, and checks the rows that are left:

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteFactory } from './factories/NoteFactory.ts';

it('deletes a note', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const note = await app.factory(NoteFactory).create({ user_id: ada.id });
  await app.actingAs(ada).acting().delete(`/notes/${note.id}`).assertOk();
  await app.assertDatabaseMissing('notes', { id: note.id });
});
```

The next test starts with an empty database again: everything this test wrote is rolled back when it ends.

## How the database is reset

Each test worker of Vitest gets a database of its own, so tests that run in parallel never meet:

- **SQLite:** a file in the app's `storage/framework/testing/`, one per worker process. The next worker that starts in the app deletes the files of finished ones, so a run leaves at most about one
  file per worker. The folder is created when it is missing.
- **Postgres:** a database next to the configured one, named `<database>_test_<app>_<process>_<thread>`. The test run drops and creates it,
  and drops the ones of this app whose worker process is gone, so the database's user needs the right to create and drop databases. The name includes a hash of the host name and the app's directory, so runs on different hosts never drop each other's databases.
  Databases left by an earlier naming (`<database>_test_…` ending in a single number) are not removed automatically; drop them by hand.

Each test file starts with a fresh database: before its first refreshed test, the file's worker drops its database, creates it
and runs the migrations. Then each test app pins one connection of the `default` database connection and runs every query on it,
inside one transaction. When the test ends, the transaction is rolled back, and the next test of the file starts empty without
migrating again.

Your app's code works as it does in production:

- A transaction the app opens, with `connections.transaction()`, becomes a savepoint inside the test's transaction. A rollback of
  it undoes its own writes only.
  A savepoint has no isolation level, so an `isolationLevel` option has no effect in a test; it applies in production.
- Work registered with `afterCommit()` runs when the app's own transaction commits, although nothing is committed for real.
- Work after a response runs outside the app's transactions, as in production.
- `outsideTransaction()` inside a transaction of the app cannot reach the database in a test: the pinned connection belongs to
  that transaction, so a query throws a `TransactionError` instead of waiting forever. Production on SQLite behaves the same, and
  Postgres does not. Do such work after the transaction.

Requests that a test sends at the same time share the pinned connection. Their outermost transactions run one after another: the
second begins when the first has ended, and what the first wrote is already visible to it. That is not how the app behaves in
production, where such requests compete. A check that reads and then writes in several statements, such as counting the free seats
and then inserting, passes here even without the lock that protects it, so
[test those with `database: 'isolated'`](#testing-a-lock). A single statement that decides by itself, such as an `update … where`
with a condition or a unique index, is as right or wrong here as in production.

> [!NOTE]
> Only the `default` connection is reset. Rows written through another connection, such as a `system` connection of your
> own, stay after the test. Point what tests write to `default` in `.env.test`, or set that connection's database to
> `:memory:` there.

Two test runs of one app at the same time are not supported: on SQLite, a run in a container and one on the host that share the app's directory remove each other's files. The names of the workers' databases are not API.

### One refreshed app at a time

A test works on the worker's one database, so only one test app with a `database`, `'refresh'` or `'isolated'`, may be open at a time.
A second one stops the test, naming the mode of the open one:

```text
Another test app with database: 'refresh' is still open. Close it first (await app.close()) — each test works on the worker's one database.
```

A test app made inside a test closes when the test ends. To switch to a test app with other options in the middle of a test,
close the first one with `await app.close()`. A test that closes the database connections itself, with `connections.destroy()`,
rolls its transaction back right there, and the cleanup at the end of the test has nothing left to do.

A hook or test that times out while its app is still starting leaves nothing open: when the app is ready at last and the test is
over, it is closed again and `createTestApp()` throws, so the next test does not fail with the message above. For the first app of a
worker, which creates and migrates the worker's database, give the file a `beforeAll` of its own with a longer hook timeout and
open and close one app there.

## Testing a lock

Code that reads and then writes in several statements, such as counting the free seats and then inserting a booking, needs a lock
(`forUpdate()`) so that two requests do not both read the same free seats. `database: 'refresh'` cannot show that the lock is
there: its requests take turns, so code that forgot it passes. (A single statement that decides by itself, an `update … where`
with a condition or a unique index, needs no lock, and a test of it fails without the condition under `'refresh'` too.)
`database: 'isolated'` runs the test app on its real connection pool. Nothing is wrapped in a transaction, every commit is real, and requests sent together compete
as they do in production:

```ts title="modules/workshops/booking.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WorkshopFactory } from './factories/WorkshopFactory.ts';

it('books no more seats than the workshop has', async () => {
  const app = await createTestApp(application, { database: 'isolated' });
  const workshop = await app.factory(WorkshopFactory).create({ capacity: 2 });
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.post(`/workshops/${workshop.id}/bookings`, { json: { guest: 'Ada' } })));
  expect(responses.filter((response) => response.status === 201)).toHaveLength(2);
  await app.assertDatabaseCount('bookings', 2);
});
```

With `database: 'isolated'` the tables are emptied when the test app starts and again when it closes, all but the record of
migrations, so a later test, refreshed or isolated, finds no rows left over. The ids start over too. `seed: true` seeds after
the tables were emptied. The worker's database, its migration and the rule of one open test app with a database are the same as with
`'refresh'`: close the app before you open another. A test app that is not closed leaves its rows until the next one starts.

Use the mode for the tests that need it. Emptying every table and committing is slower than a rollback, and a test that fails
leaves nothing to look at after the app has closed.

Prove that the test can fail. Remove the lock from the code, for example the `forUpdate()` of the query that reads the free seats,
and run the test again: it must turn red, here with five bookings. The same test with `database: 'refresh'` stays green without
the lock, which is what that mode cannot tell you. Put the lock back afterwards.

Row locks are checked on Postgres. SQLite has one writer at a time, so on SQLite the test runs, but the writes never overlap and
it stays green without the lock: run such tests on Postgres ([Running the tests on Postgres](#running-the-tests-on-postgres)).

A refreshed test that sends requests together while Postgres makes them take turns prints a warning once for each test app:

```text
(node:1234) [MARMEON_SERIAL_TRANSACTIONS] MarmeonDatabaseWarning: Two requests' transactions took turns: under database: 'refresh' concurrent requests run one after another, so a missing lock still passes. Test a lock with database: 'isolated' — docs/database-testing.md#testing-a-lock
```

It does not fail the test. If the requests need no lock, ignore it.

## Factories

`app.factory(Factory)` makes rows in the test's database. A factory names a table and the attributes of a row, and the module
keeps it in its `factories` folder:

```ts title="modules/notes/factories/NoteFactory.ts"
import { defineFactory } from '@marmeon/database';
import { UserFactory } from '#modules/auth';

export const NoteFactory = defineFactory(
  'notes',
  ({ sequence, factory }) => ({
    user_id: factory(UserFactory),
    title: `Note ${sequence}`,
    body: 'Some text.',
  }),
  { states: { pinned: { pinned: true } } },
);
```

A test asks for one row, several, or a variant:

```ts
const note = await app.factory(NoteFactory).create();
const notes = await app.factory(NoteFactory).count(3).create({ user_id: ada.id });
const pinned = await app.factory(NoteFactory).state('pinned').create();
const attributes = app.factory(NoteFactory).make();
```

`create()` inserts the rows and resolves with them as stored, with their ids and defaults. `count(n)` makes `n` rows, and
`create()` then resolves with an array. `state(name)` applies a named state, and `state({ … })` a set of attributes. `make()`
returns the attributes without inserting anything. `factory(UserFactory)` in a definition creates the related row first and puts
its id in the column, with `create()`. `make()` creates no related row and leaves that column as the pending factory. The
[seeding](seeding.md#defining-factories) page explains how to write factories.

The starter kit's `UserFactory` makes users with a confirmed address and the password `password`. Its `unverified` state makes a
user who has not confirmed the address yet.

## Seeding

`seed: true` runs the modules' seeders before every test, inside the test's transaction:

```ts title="modules/notes/dashboard.test.ts"
import { UserRepository } from '#modules/auth';
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('greets the seeded user', async () => {
  const app = await createTestApp(application, { database: 'refresh', seed: true });
  const user = await app.make(UserRepository).findByEmail('test@example.com');
  await app.actingAs(user!).navigating().get('/dashboard').assertOk().assertPage('auth/Dashboard', { name: 'Test User' });
});
```

Seeding runs for every test, so keep the seeders small, or create what a test needs with factories instead. The
[seeding](seeding.md#writing-seeders) page covers seeders.

## Database assertions

Three assertions check the rows of a table:

```ts
await app.assertDatabaseHas('notes', { user_id: ada.id, title: 'Groceries' });
await app.assertDatabaseMissing('notes', { title: 'Groceries', archived_at: null });
await app.assertDatabaseCount('notes', 3);
```

`assertDatabaseHas()` passes when a row matches every given column, and `assertDatabaseMissing()` when none does. A `null` value
matches `IS NULL`. `assertDatabaseCount()` passes when the table holds exactly that many rows. They are typed by your tables: an
unknown table, an unknown column or a value of the wrong type is a compile error.

A failed assertion shows what the table holds:

```text
Expected a row in "notes" matching {"title":"Groceries"} — found none.
  The table has 1 rows, e.g.:
    {"id":1,"user_id":1,"title":"Shopping","body":"Some text.","pinned":false,"archived_at":null}
```

To check more than a match, read the rows yourself through the app's repositories: `await app.make(NoteRepository).find(note.id)`.

## Stores on the database

Sessions, the cache, locks, rate limits and uploads can keep their data in the database. Their database drivers write on a
connection that never joins the app's transactions. In a test that connection is the test's pinned connection, so:

- outside a transaction of the app they work, and what they write is rolled back with the test;
- inside a transaction of the app, every statement of theirs throws an `InfrastructureTransactionError`, as on a single SQLite
  file in production.

On Postgres in production, the same code inside a transaction works, because the stores have a pool of their own there. A test
that hits the error shows code that would fail on SQLite. A new app's `.env.test` keeps sessions and the cache in memory, so the
error only comes up in a test that switches them to the database. The [database](database.md#infrastructure-connections) page
explains infrastructure connections.

## Running the tests on Postgres

With `DB_DRIVER=pgsql` and the server in the environment, refreshed test apps use Postgres instead of SQLite. Name the
database in the shell too, since otherwise the `DB_DATABASE=:memory:` of `.env.test` names it:

```sh
DB_DRIVER=pgsql DB_HOST=localhost DB_DATABASE=notes DB_USERNAME=notes DB_PASSWORD=secret pnpm test
```

`DB_URL=postgres://notes:secret@localhost:5432/notes` instead of the four does the same, and then `DB_DATABASE` is not read.

Each worker gets its own database next to `notes`, as described above. Postgres finds what SQLite hides, such as a column type
or a constraint the other server reads differently, so run the suite on the database you deploy to before you ship. It does not
find two requests that race for the same row in a refreshed test: those take turns. [Testing a lock](#testing-a-lock) shows how
to test that.

> [!WARNING]
> The test run drops and creates databases on that server, and a variable in the shell wins over `.env.test`. Point it
> at a development server only, never at one that holds real data. The [database](database.md#configuration) page
covers the connection settings.
