# Transactions

## Introduction

A transaction makes several writes one: they all count, or none does. Run the work in `connections.transaction()`, and everything
the callback awaits joins the transaction by itself: repositories, any query of the connection, the database queue and the
listeners of an event. You pass no transaction object around.

```ts title="modules/notes/NotePublishing.ts"
import { EventDispatcher } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { Queue } from '@marmeon/queue';
import { NotePublished } from './events/NotePublished.ts';
import { RebuildFeedJob } from './jobs/RebuildFeedJob.ts';
import { NoteRepository } from './NoteRepository.ts';
import { RevisionRepository } from './RevisionRepository.ts';

export class NotePublishing {
  readonly #connections: Connections;
  readonly #notes: NoteRepository;
  readonly #revisions: RevisionRepository;
  readonly #events: EventDispatcher;
  readonly #queue: Queue;

  constructor(connections: Connections, notes: NoteRepository, revisions: RevisionRepository, events: EventDispatcher, queue: Queue) {
    this.#connections = connections;
    this.#notes = notes;
    this.#revisions = revisions;
    this.#events = events;
    this.#queue = queue;
  }

  publish(id: number) {
    return this.#connections.transaction(async () => {
      const note = await this.#notes.update(id, { published_at: new Date() });
      if (!note) return undefined;
      await this.#revisions.insert({ note_id: note.id, title: note.title, body: note.body });
      await this.#events.dispatch(new NotePublished(note)); // its listeners write into the transaction too
      await this.#queue.dispatch(RebuildFeedJob, { userId: note.user_id }); // on the database queue: a row in the transaction
      return note;
    });
  }
}
```

The transaction commits when the callback resolves, and `transaction()` resolves with the callback's result. When the callback
throws, the transaction rolls back and the error reaches the caller. When it returns an [`err`](errors.md#results), the
transaction rolls back too, and the caller gets the `err`: see [returning an err](#returning-an-err). A rollback takes back the
note, the revision, whatever the listeners wrote, and the queued job.

## Running a transaction

| Call | What it does |
| --- | --- |
| `connections.transaction(callback)` | A transaction on the default connection. |
| `connections.transaction(callback, { connection: 'reporting' })` | A transaction on another connection. |
| `connections.transaction(callback, { isolationLevel: 'serializable' })` | Sets the isolation level of an outermost transaction: `'read committed'`, `'repeatable read'` or `'serializable'`. |
| `repository.transaction(callback)` | A transaction on the repository's connection. The callback receives the repository. |
| `inTransaction()` | Whether the current code runs inside a transaction. Import it from `@marmeon/database`. |
| `connections.inTransaction(name?)` | Whether it runs inside a transaction of that connection. |

Postgres applies an isolation level. SQLite has one writer at a time and ignores it. Any other value, `'snapshot'` or `'read uncommitted'` for one, is a type error and throws a `TypeError` before the transaction begins. A transaction exists exactly as long as its
callback runs. "Check, then insert" is not safe on Postgres at the default isolation level: two transactions can both pass the
check. A rule such as "no two bookings overlap" belongs in a constraint, as the [bookings recipe](recipe-bookings.md) shows, with
a row lock or `isolationLevel: 'serializable'` as the other ways; the latter makes Postgres abort one transaction, and running it
again is up to you. There is no transaction per request, and none that you begin without a callback joins by itself: those are
[transactions you control yourself](#transactions-you-control-yourself).

## What joins a transaction

| Inside `transaction()` | What happens |
| --- | --- |
| Repositories, `Database`, `connections.get()` of the same connection | They join the transaction. |
| `queue.dispatch()` on the `database` queue of the same connection | The job is a row in the transaction: there with the commit, gone with a rollback. |
| `queue.dispatch()` on `redis`, `sync` or another connection | Held until the outermost commit, dropped on a rollback. A `sync` job then runs outside the transaction. |
| The listeners of `events.dispatch()` | They run inside the transaction. |
| Queued listeners, `mailer.queue()`, `notifications.send()` | Jobs, queued like `queue.dispatch()`. |
| `notifications.sendNow()` | When `NOTIFICATIONS_CONNECTION` is the transaction's connection, its row is written inside it. On another connection the row is committed by a transaction of its own and survives a rollback. Its mail is queued like `mailer.queue()` either way. |
| `broadcast.refresh()` | Sent once the outermost transaction committed. A rollback sends nothing. |
| The database cache with its rate limits and locks, the database sessions, uploads | **Never join.** On Postgres, and on SQLite with a file of their own, they write on [a connection of their own](database.md#infrastructure-connections), and their writes survive a rollback. With the app's own SQLite file, and in a test's refreshed database, they throw `InfrastructureTransactionError` inside a transaction. |
| `mailer.send()`, a file written to a disk, a call to another service | Happen at once and are not undone. Use [`afterCommit()`](#after-the-commit). |

The [queues](queues.md#inside-a-transaction) page explains the queue's side, and the [events](events.md#queued-listeners) page
queued listeners.

### Where the transaction ends

The transaction follows the call chain of its callback, and nothing else. It never reaches another request, job or test that runs
at the same time. The framework also cuts it at its own boundaries, so work that runs later never joins a transaction that
happened to be open when it was registered:

- work after the response: `afterResponse.defer()` and the `terminate` of a middleware;
- every job, whether a worker runs it, the `sync` connection or a test;
- scheduled tasks.

## Nested transactions

A `transaction()` inside another one becomes a **savepoint**. That holds for your own nested calls, a repository's `tryInsert()`,
and Kysely's own `db.transaction()`. A savepoint that rolls back takes back its own writes and keeps those before it. When the
outer transaction rolls back, everything is undone, the committed savepoints too:

```ts
await this.#connections.transaction(async () => {
  await this.#notes.insert(row);
  try {
    await this.#connections.transaction(async () => {
      await this.#tags.attach(noteId, tags);
      throw new TagLimitError();
    });
  } catch {
    // the tags are gone, the note stays
  }
});
```

On Postgres, a statement that fails aborts the transaction it runs in. Catch the error outside the nested `transaction()`, never
inside it; a transaction whose error was caught inside it rolls back and throws `TransactionError` (D24), and the transaction around
a savepoint can go on. Use `tryInsert()` where a taken value is expected. A savepoint you roll back yourself has to be a statement
of its own that starts with `rollback to`: a recovery behind a comment or after another statement in the same query is not
recognized, and the commit still throws D24.

Open nested transactions one after the other. Several at once, such as `transaction()` calls in a `Promise.all`, would share one
connection, so the second one throws:

```text
Two transactions were opened at the same time inside one transaction on "default" (Promise.all over transaction() calls?) — they would share one connection and interleave their savepoints. Run them one after the other.
```

A savepoint has no isolation level of its own, so `isolationLevel` on a nested `transaction()` throws as well.

## Returning an err

An expected failure is a [`Result`](errors.md#results), and a callback that returns an `err` rolls its transaction back, as if
it had thrown. `transaction()` returns the `err` unchanged instead of throwing it. A savepoint that returns one takes back its own
writes only, and after-commit work is dropped while [after-rollback work](#after-a-rollback) runs, just as after an exception.

Some errors are a change of their own that must stay: a request that is dropped, or a failed attempt that is counted. Return
those as `commitAnyway(err(…))`, and the transaction commits:

```ts title="modules/teams/Invitations.ts"
import { commitAnyway, err, ok, type Result } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { InvitationRepository } from './InvitationRepository.ts';
import { MemberRepository } from './MemberRepository.ts';
import type { Member } from './members.ts';

export type AcceptError = { kind: 'expired' } | { kind: 'already-member'; teamId: number };

export class Invitations {
  readonly #connections: Connections;
  readonly #invitations: InvitationRepository;
  readonly #members: MemberRepository;

  constructor(connections: Connections, invitations: InvitationRepository, members: MemberRepository) {
    this.#connections = connections;
    this.#invitations = invitations;
    this.#members = members;
  }

  accept(tokenHash: string, userId: number): Promise<Result<Member, AcceptError>> {
    return this.#connections.transaction(async () => {
      const invitation = await this.#invitations.claim(tokenHash, new Date());
      if (!invitation) return err({ kind: 'expired' }); // rolls back: nothing to keep
      await this.#invitations.delete(invitation.id);
      if (await this.#members.isMember(invitation.team_id, userId)) {
        // The invitation is used up all the same: the delete commits, and the caller gets a plain err.
        return commitAnyway(err({ kind: 'already-member', teamId: invitation.team_id }));
      }
      return ok(await this.#members.insert({ team_id: invitation.team_id, user_id: userId }));
    });
  }
}
```

`commitAnyway()` takes an `err` only, and it marks that one return of that one callback. The caller gets a plain `err`; if it
returns that `err` from a transaction of its own, that transaction rolls back. Inside another transaction, `accept()` runs as a
savepoint, so that rollback takes back the deleted invitation as well. To keep it, mark the `err` again where you pass it on:

```ts
return this.#connections.transaction(async () => {
  const accepted = await this.#invitations.accept(tokenHash, userId);
  if (!accepted.ok) return commitAnyway(accepted); // the invitation stays used up
  await this.#activity.insert({ team_id: accepted.value.team_id, user_id: userId, action: 'joined' });
  return accepted;
});
```

That commits the writes of the outer callback too. A write that must stay whatever its callers do, such as a failed-attempt
counter, belongs in [`outsideTransaction()`](#outside-the-transaction) instead.

A rollback looks for the results that `err()` made. An object that only looks like one, such as a JSON payload with `ok: false`
or a copy made with `{ ...result }`, commits like any other value.

`connections.transaction()` and a repository's `transaction()` both roll back on an `err`, whether they run as a savepoint or
over a transaction bound with `using(trx)`. Kysely's own `db.transaction().execute()` knows no results and commits whatever its
callback returns.

## Await everything

Work that started inside the callback but runs after the transaction finished, such as a promise you did not await or a timer,
throws instead of writing outside the transaction:

```text
This work was started inside transaction() on "default" but ran after that transaction was committed — await it inside the callback, or wrap it in outsideTransaction() if it should run on its own.
```

The error is a `TransactionFinishedError`. Such work never runs on the bare connection by accident.

## After the commit

Some work must happen only for data that exists: a mail, a cache write, a call to another service. `afterCommit(fn)` runs `fn`
once the outermost transaction has committed, outside of any transaction, and never after a rollback:

```ts title="modules/notes/NoteSharing.ts"
import { afterCommit, Connections } from '@marmeon/database';
import { Mailer } from '@marmeon/mail';
import { NoteSharedMail } from './mail/NoteSharedMail.ts';
import { ShareRepository } from './ShareRepository.ts';

export class NoteSharing {
  readonly #connections: Connections;
  readonly #shares: ShareRepository;
  readonly #mailer: Mailer;

  constructor(connections: Connections, shares: ShareRepository, mailer: Mailer) {
    this.#connections = connections;
    this.#shares = shares;
    this.#mailer = mailer;
  }

  share(noteId: number, email: string, mail: NoteSharedMail) {
    return this.#connections.transaction(async () => {
      const share = await this.#shares.insert({ note_id: noteId, email });
      await afterCommit(() => this.#mailer.send(mail));
      return share;
    });
  }
}
```

Outside a transaction, `afterCommit()` runs `fn` at once and resolves when it is done. Inside one, it resolves at once. Inside a
savepoint, `fn` is handed on to the transaction around it when the savepoint commits, and dropped when the savepoint rolls back.
When `fn` fails, the `transaction()` call that committed throws its error, or an `AggregateError` when several failed: the data is
committed by then. A mail that can wait for a worker is simpler still: `mailer.queue()` inside the transaction is held for the
commit by itself.

## Outside the transaction

`outsideTransaction(fn)` of `@marmeon/database` runs `fn` outside the current transaction. Its writes are kept even when the
transaction rolls back, which is what a failed-attempt counter or a security log needs:

```ts
await this.#connections.transaction(async () => {
  if (!(await this.#codes.consume(user, code))) {
    await outsideTransaction(() => this.#attempts.recordFailure(user.id)); // kept although the transaction rolls back
    throw new InvalidCodeError();
  }
  await this.#users.update(user.id, { two_factor_confirmed_at: new Date() });
});
```

This needs a second physical connection, which Postgres has in its pool. On SQLite, and in a test's isolated database, there is
only one, and the open transaction holds it. There the database work inside `outsideTransaction()` fails at once with a
`TransactionError` instead of waiting forever. Record such things after the transaction instead: catch the error, record, and
throw it again.

The framework's rate limits, locks and sessions need none of this. On Postgres, and on SQLite with a file of their own, they
always write on their own connection. With the app's own SQLite file, and in a test's refreshed database, they cannot work inside
a transaction and throw `InfrastructureTransactionError`. The [database](database.md#infrastructure-connections) page shows how to
give them a file of their own.

## After a rollback

`afterRollback(fn)` is the counterpart of `afterCommit()`: it undoes work that was done *outside* the transaction on its behalf.
A lock taken on the cache's own connection is the usual case. It is visible to every process at once, and the job it guards is a
row in the transaction. The example needs a cache that works inside a transaction: any driver but `database` on the app's own
SQLite file:

```ts title="modules/notes/FeedRebuilds.ts"
import { Cache } from '@marmeon/cache';
import { afterRollback, Connections } from '@marmeon/database';
import { Queue } from '@marmeon/queue';
import { RebuildFeedJob } from './jobs/RebuildFeedJob.ts';

export class FeedRebuilds {
  readonly #connections: Connections;
  readonly #cache: Cache;
  readonly #queue: Queue;

  constructor(connections: Connections, cache: Cache, queue: Queue) {
    this.#connections = connections;
    this.#cache = cache;
    this.#queue = queue;
  }

  request(userId: number) {
    return this.#connections.transaction(async () => {
      const lock = this.#cache.lock(`feed:rebuild:${userId}`, 600);
      if (!(await lock.get())) return;
      await afterRollback(() => lock.release()); // the job below never existed: free the lock again
      await this.#queue.dispatch(RebuildFeedJob, { userId });
    });
  }
}
```

`fn` runs right after the rollback, outside of any transaction, and never after a commit. It belongs to the innermost transaction:
a savepoint that rolls back runs it at once, since what it cleans up after is gone, even if the transaction around it commits. A
savepoint that commits hands it on to the transaction around it. Outside a transaction it never runs.

When `fn` fails, the error that rolled the transaction back is not lost: `transaction()` throws a `SuppressedError` whose `error`
is the failure of `fn` and whose `suppressed` is the original error. After an `err` there is no error to keep, so
`transaction()` throws the failure of `fn` itself, or an `AggregateError` when several failed.

A [unique job](queues.md#unique-jobs) does exactly this for you, so the lock of a unique dispatch needs no `afterRollback()` of
your own.

## Transactions you control yourself

The callback of `connections.transaction()` also receives the transaction as a `Transaction`, for code outside the call
chain. Three helpers bind to a transaction explicitly:

- `repository.using(trx)` builds the repository again, working in `trx`. This is why a repository's constructor takes only
  `Connections`: with more parameters, `using()` throws and says so.
- `queue.using(trx).dispatch(…)` writes the job's row through `trx`. Nothing reports the commit of a transaction you began yourself, so `JobQueued` is not fired for it, and a `sync` or unique job through it throws a `QueueError`; dispatch those inside `connections.transaction()`.
- `factory(…).using(trx)` inserts a factory's rows through it.

They are for transactions the ambient context does not know: one you start with Kysely's `db.startTransaction()`, a second
connection at the same time, or code that runs outside the callback's call chain:

```ts
const trx = await this.#db.startTransaction().execute();
try {
  await this.#notes.using(trx).insert(row);
  await this.#queue.using(trx).dispatch(RebuildFeedJob, { userId: row.user_id });
  await trx.commit().execute();
} catch (error) {
  await trx.rollback().execute();
  throw error;
}
```

Such a transaction reports neither its commit nor its rollback, so the job above is a row that exists once `trx` commits, but
`JobQueued` is not fired for it, and a `sync` job or a unique job dispatched through it throws a `QueueError`.

Kysely's own `db.transaction().execute(callback)` is not ambient either. Outside `connections.transaction()` it is a plain
transaction, and inside its callback only `trx`, or a repository bound with `using(trx)`, is in it. A query on the plain `db`
there waits for the connection the transaction holds: on SQLite, which has one connection, it waits forever.

## Testing

With `createTestApp(application, { database: 'refresh' })`, every test runs inside one transaction that is rolled back when the
test ends. Your transactions become savepoints in it and work as they do in the app. Transactions that run at the same time take
turns on the test's one connection. Like the app's own SQLite file, that one connection makes the database cache, sessions and
uploads throw `InfrastructureTransactionError` inside a transaction, and `outsideTransaction()` throw a `TransactionError`. The
[database testing](database-testing.md#how-the-database-is-reset) page explains it.
