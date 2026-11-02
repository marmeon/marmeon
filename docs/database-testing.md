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
- A statement the database refuses, such as a duplicate key, a failed check or a trigger that raises, does not end the test on
  SQLite: the next query runs. On Postgres it aborts the test's transaction, and every later query of the test fails with
  `current transaction is aborted, commands ignored until end of transaction block`, which names neither the refused statement nor
  the rule. In production each statement outside a transaction stands alone, so the same code goes on. A test of a constraint or
  a trigger therefore refuses the statement inside a savepoint (see [below](#a-statement-the-database-refuses)). `tryInsert()` takes
  one too, but hands back only a taken unique value as a result; a check or a trigger that refuses its insert still throws.
- Work registered with `afterCommit()` runs when the app's own transaction commits, although nothing is committed for real.
- Work after a response runs outside the app's transactions, as in production.
- `outsideTransaction()` inside a transaction of the app cannot reach the database in a test: the pinned connection belongs to
  that transaction, so a query or a transaction throws a `TransactionError` instead of waiting forever. Production on SQLite behaves the same, and
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

### A statement the database refuses

Refuse the statement inside a savepoint: the rule fires, the savepoint rolls back, and the test's transaction stays usable.
`connections.transaction()` inside a test is that savepoint:

```ts title="modules/audit/auditLog.test.ts"
import { Connections } from '@marmeon/database';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('refuses to delete an entry of the audit log', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const connections = app.make(Connections);
  // A trigger fires for a row, so the log needs an entry for the delete to be refused.
  await connections.get().insertInto('audit_logs').values({ entry: 'created' }).execute();
  // A transaction inside the test's own is a savepoint: the refusal rolls back to it, and the test's transaction stays usable.
  await expect(connections.transaction(() => connections.get().deleteFrom('audit_logs').execute())).rejects.toThrow(/append-only/);
  // The test goes on: without the savepoint this query would fail with "current transaction is aborted". The entry is still there,
  // so the rollback took back the refused statement only.
  await app.assertDatabaseCount('audit_logs', 1);
});
```

On Postgres, catch the refusal outside the `transaction()`, as here; a catch inside it ends in a `TransactionError`. A
repository's `tryInsert()` does the same for a taken unique value and hands it back as an `err` of kind `duplicate`, so the test
checks the `ok` of the result. Under `database: 'isolated'` every statement commits for real and a refusal stands alone, as in production, but that
mode is slower.

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
worker, which loads the app's modules (about a second) and on Postgres creates and migrates the worker's database, raise the
timeout of the step that opens it: `testTimeout` (five seconds by default) when a test opens the app, `hookTimeout` (ten seconds)
when a `beforeEach` or `beforeAll` does. Or give the file a `beforeAll` of its own with a longer hook timeout and open and close one
app there.

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
migrations, so a later test, refreshed or isolated, finds no rows left over. The ids start over too. That holds for a table
whose trigger refuses `TRUNCATE` or `DELETE`, such as an append-only audit log: for that one emptying, on the worker's own test
database only, the triggers of the emptied tables are put aside and back in the same transaction (a failure rolls them back
too), so every statement of your test meets them. The role of `DB_URL` creates and migrates that database and owns its tables;
if a migration takes `TRUNCATE` from that role, or someone else owns a table with such a trigger, the test app does not start
and the error names the table. Take privileges from the role your app runs as in production, not from the one that creates the
test database. `seed: true` seeds after
the tables were emptied. The worker's database, its migration and the rule of one open test app with a database are the same as with
`'refresh'`: close the app before you open another. A test app that is not closed leaves its rows until the next one starts.

Use the mode for the tests that need it. Emptying every table and committing is slower than a rollback, and a test that fails
leaves nothing to look at after the app has closed.

Prove that the test can fail. Remove the lock from the code, for example the `forUpdate()` of the query that reads the free seats,
and run the test again: it must turn red, here with five bookings. The same test with `database: 'refresh'` stays green without
the lock, which is what that mode cannot tell you. Put the lock back afterwards. A test of a lock that has never been seen red
proves nothing.

Row locks are checked on Postgres. SQLite has one writer at a time, so on SQLite the test runs, but the writes never overlap and
it stays green without the lock: run such tests on Postgres ([Running the tests on Postgres](#running-the-tests-on-postgres)).

A refreshed test that sends requests together while Postgres makes them take turns prints a warning once for each test app:

```text
(node:1234) [MARMEON_SERIAL_TRANSACTIONS] MarmeonDatabaseWarning: Two requests' transactions took turns: under database: 'refresh' concurrent requests run one after another, so a missing lock still passes. Test a lock with database: 'isolated' — docs/database-testing.md#testing-a-lock
```

It does not fail the test. If the requests need no lock, ignore it.

### Make the overlap certain

Requests sent together are not certain to overlap, even with `database: 'isolated'`. The pool opens its connections as they are
needed, so right after the app started two short transactions can run one after the other, and the test stays green without the
lock. The same happens with a service that two `Promise.all` calls enter when the work between the read and the write takes a
fraction of a millisecond. Do not widen the window with a pause: it makes the test slow and still flaky. Hold the lock yourself
instead, change what the decision depends on while it is held, and see the code under test refuse:

1. A transaction of the test locks the row and stays open.
2. The test sends the request. If the code takes the lock, its transaction waits for the row.
3. The test polls until Postgres lists a backend that waits in a locking read (`for update`).
4. While it waits, the first transaction writes what the decision reads, here two bookings for the last two seats, and ends.
5. The request ends, and the test checks that it refused and that no third booking exists.

Waiting alone proves too little: code that reads the free seats first and locks afterwards, or that locks the row with an
`update` instead of `for update`, waits as well and still overbooks. Only a request that reads after the lock sees the two
bookings the test wrote while it waited. Keep the hold and the wait in two functions of the test folder:

```ts title="modules/workshops/lockTesting.ts"
import { Connections, sql } from '@marmeon/database';
import { expect, vi } from 'vitest';

/**
 * Locks a row in a transaction of its own and keeps it until the returned function is called. That function runs `whileHeld`
 * inside the transaction, then ends it. `for no key update` makes the `for update` of the code under test wait, but not the
 * key-share lock a foreign key takes when the code inserts a child row: a plain `for update` here would make an insert wait
 * even where the code under test has no lock.
 */
export async function holdRow(
  connections: Connections,
  table: string,
  id: number,
  whileHeld?: () => Promise<void>,
): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const hasLock = new Promise<void>((resolve) => (locked = resolve));
  const holder = connections.transaction(async () => {
    await sql`select id from ${sql.table(table)} where id = ${id} for no key update`.execute(connections.get());
    locked();
    await gate;
    await whileHeld?.();
  });
  await Promise.race([hasLock, holder]);
  return async () => {
    release();
    await holder;
  };
}

/** Passes once a backend of the test database waits in a `for update` read, and fails after five seconds. */
export async function untilSomeoneWaits(connections: Connections): Promise<void> {
  await vi.waitFor(
    async () => {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike '%for update%'
      `.execute(connections.get());
      expect(rows[0]?.waiting).toBe(1);
    },
    { timeout: 5000 },
  );
}
```

The test that uses them:

```ts title="modules/workshops/booking.test.ts"
import { Connections } from '@marmeon/database';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WorkshopFactory } from './factories/WorkshopFactory.ts';
import { holdRow, untilSomeoneWaits } from './lockTesting.ts';

it.skipIf(process.env.DB_DRIVER !== 'pgsql')('counts the seats after it has locked the workshop', async () => {
  const app = await createTestApp(application, { database: 'isolated' });
  const connections = app.make(Connections);
  const workshop = await app.factory(WorkshopFactory).create({ capacity: 2 });

  const release = await holdRow(connections, 'workshops', workshop.id, async () => {
    await connections.get().insertInto('bookings').values([{ workshop_id: workshop.id, guest: 'Grace' }, { workshop_id: workshop.id, guest: 'Alan' }]).execute();
  });
  const booking = app.post(`/workshops/${workshop.id}/bookings`, { json: { guest: 'Ada' } });
  try {
    await untilSomeoneWaits(connections);
  } finally {
    await release();
  }

  expect((await booking).status).toBe(409);
  await app.assertDatabaseCount('bookings', 2);
});
```

The code that locks first and then counts waits, finds the two seats gone and refuses. Remove the `forUpdate()` and the test
fails in `untilSomeoneWaits()`, or on the status if the code locks after it counted: the booking is the third. The `finally`
releases the row, so a failing test does not leave a transaction open. `holdRow()` and the request use one connection each and
the poll a third, so the pool of ten has room.

### Several locks

Code that locks several rows, such as a booking that takes every resource it names, locks them in one order, by key, so that
two bookings naming the same resources in opposite orders wait for each other instead of deadlocking. The order is a property of
the code, and a test of two bookings that run together shows it only when the unlucky interleaving happens to occur. Test it
with the same hold. Hold the middle row, send a booking that names the rows in the wrong order, wait until it waits, and probe
the other rows with `nowait`: a row the booking holds refuses at once (error code `55P03`), a free one does not.

```ts title="modules/resources/booking.test.ts"
import { Connections, sql } from '@marmeon/database';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { ResourceFactory } from './factories/ResourceFactory.ts';
import { holdRow, untilSomeoneWaits } from '../workshops/lockTesting.ts';

it.skipIf(process.env.DB_DRIVER !== 'pgsql')('locks the resources in the order of their ids', async () => {
  const app = await createTestApp(application, { database: 'isolated' });
  const connections = app.make(Connections);
  const [low, middle, high] = await app.factory(ResourceFactory).count(3).create();

  const release = await holdRow(connections, 'resources', middle!.id);
  const booking = app.post('/bookings', { json: { resources: [high!.id, middle!.id, low!.id] } });
  const isHeld = (id: number) =>
    sql`select id from resources where id = ${id} for update nowait`.execute(connections.get()).then(
      () => false,
      (error: unknown) => {
        if ((error as { code?: string }).code === '55P03') return true; // lock_not_available
        throw error;
      },
    );
  try {
    await untilSomeoneWaits(connections);
    // The booking waits for the middle row, so it holds the rows before it in its order and none after it.
    expect(await isHeld(low!.id), 'the lowest id is locked first').toBe(true);
    expect(await isHeld(high!.id), 'the highest id is still free').toBe(false);
  } finally {
    await release();
  }
  expect((await booking).status).toBe(201);
});
```

This checks the order of a loop that locks one row after the other; the code puts the lowest id first with an `orderBy('id')` or
a sort before the loop. A single `where id in (…) for update` locks the rows in the order Postgres reads them, which for rows a
factory just created is the order of their ids, so this test passes for it with or without an `orderBy('id')` in the code and says
nothing about the order. Keep that `orderBy('id')` in code you review. If two code paths lock the same rows, they need the same
order, and a test of each is cheap with this hold.

## Counting statements

A test that asks how often the code asks the database, such as a list that must not run one query per row, listens to the
connections. `connections.onQuery(listener)` hears every statement with its SQL and returns the function that stops it
([observability](observability.md#queries-and-secret-columns)):

```ts title="modules/workshops/workshops.test.ts"
import { Connections } from '@marmeon/database';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WorkshopFactory } from './factories/WorkshopFactory.ts';

it('asks for the bookings of all workshops at once', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  await app.factory(WorkshopFactory).count(5).create();
  const statements: string[] = [];
  const stop = app.make(Connections).onQuery((query) => void statements.push(query.sql));
  try {
    await app.get('/workshops').assertOk();
  } finally {
    stop();
  }
  expect(statements.filter((statement) => statement.includes('"bookings"'))).toHaveLength(1);
});
```

Count the statements that mention a table rather than all of them: `begin`, `commit`, `savepoint` and the queries of the
session and of the authenticated user arrive at the listener too. Five workshops show a query per row, which one workshop would
hide.

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
database in the shell too, since the start refuses the `DB_DATABASE=:memory:` of `.env.test` (`[marmeon:K6]`):

```sh
DB_DRIVER=pgsql DB_HOST=localhost DB_DATABASE=notes DB_USERNAME=notes DB_PASSWORD=secret pnpm test
```

`DB_URL=postgres://notes:secret@localhost:5432/notes` instead of the four does the same, and then `DB_DATABASE` is not read.

Each worker gets its own database next to `notes`, as described above. `notes` itself need not exist yet: when the server
refuses it, the run creates its workers' databases through the server's `postgres` database, and only fails, asking you to
create `notes` first, when that one is closed to the test user too. Postgres finds what SQLite hides, such as a column type
or a constraint the other server reads differently, so run the suite on the database you deploy to before you ship. It does not
find two requests that race for the same row in a refreshed test: those take turns. [Testing a lock](#testing-a-lock) shows how
to test that.

> [!WARNING]
> The test run drops and creates databases on that server, and a variable in the shell wins over `.env.test`. Point it
> at a development server only, never at one that holds real data. The [database](database.md#configuration) page
covers the connection settings.
