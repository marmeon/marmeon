# @bespokecore/database

Data access on [Kysely](https://kysely.dev): connections (`Connections`, the typed `Database`), migrations per module,
generated table types (`bespoke db:types`), repositories, factories, seeders — and transactions.

```ts
constructor(connections: Connections, users: UserRepository) { … }
```

## Transactions

Run work in a transaction with `connections.transaction(callback)`. Everything the callback awaits joins the
transaction on its own (E107) — repositories, any `db` of the connection, the database queue, in-process event
listeners. No `using(trx)` to pass around:

```ts
const user = await this.#connections.transaction(async () => {
  const user = await this.#users.insert({ name, email });
  await this.#profiles.insert({ user_id: user.id });
  await this.#events.dispatch(new Registered(user));                  // its listeners write into the transaction too
  await this.#queue.dispatch(SendWelcomeMailJob, { userId: user.id }); // a row in the same transaction
  return user;
});
```

It commits when the callback resolves and rolls back when it throws (the error is rethrown). `repository.transaction(cb)`
is the same thing on the repository's connection. `{ connection: 'reporting' }` picks another connection,
`{ isolationLevel }` sets the isolation level of an outermost transaction.

### The rules

- **Only inside the callback.** A transaction exists exactly as long as `transaction(callback)` runs. There is no
  implicit transaction per request and no `begin` without a callback for the ambient form.
- **Nested is a savepoint.** A `transaction()` inside another one — yours, a repository's (`tryInsert`), or Kysely's own
  `db.transaction()` — becomes a savepoint: an inner rollback keeps the outer writes, an outer rollback undoes everything.
  This also ends the old trap of a second transaction on SQLite's single connection, which used to hang. Open nested
  transactions one after the other, not several at once in a `Promise.all` (that throws: they would share one connection).
- **Await everything.** Work that was started inside the callback but runs after the transaction finished — an
  un-awaited promise, a timer — throws `TransactionFinishedError`:

  > This work was started inside transaction() on "default" but ran after that transaction was committed — await it
  > inside the callback, or wrap it in outsideTransaction() if it should run on its own.

  It never silently runs on the bare connection instead.
- **After the commit:** `afterCommit(fn)` runs `fn` once the outermost transaction committed, outside of any transaction,
  and never after a rollback. Use it for the outside world — a mail, a cache write, a job on a queue outside the database:

  ```ts
  await afterCommit(() => this.#mailer.send(new VerifyEmailMail(user, …)));
  ```

  Outside a transaction, `fn` runs at once. Inside one, an error of `fn` is thrown by the `transaction()` call that
  committed — the data is committed by then.
- **Outside:** `outsideTransaction(fn)` runs `fn` outside the current transaction — for writes that must survive a
  rollback, like a failed-attempt counter or a security log entry:

  ```ts
  await this.#connections.transaction(async () => {
    if (!(await this.#codes.consume(user, code))) {
      await outsideTransaction(() => this.#attempts.recordFailure(user.id)); // kept although the transaction rolls back
      throw new InvalidCodeError();
    }
    …
  });
  ```

  On **SQLite** (and in a test's isolated connection) there is only one physical connection, and the open transaction
  holds it: `outsideTransaction()` database work fails at once with a `TransactionError` there instead of waiting forever.
  Record such things after the transaction instead — catch, record, rethrow.

  The framework's own infrastructure never needs this: the database cache store (rate limits, locks) and the database
  session store always write on [their own connection](#infrastructure-connections-e108) — never in your transaction.
- **After a rollback:** `afterRollback(fn)` is the counterpart of `afterCommit` — for work done *outside* the transaction
  on its behalf that must be undone with it, like a lock on the cache's own connection for a job whose row is in the
  transaction:

  ```ts
  await this.#connections.transaction(async () => {
    if (!(await lock.get())) return;                     // the cache's connection: every process sees it at once
    await afterRollback(() => lock.release());           // the job below never existed — free the lock again
    await this.#queue.dispatch(RebuildStatsJob, { userId });
  });
  ```

  It runs right after the rollback, outside of any transaction, and never after a commit. It belongs to the innermost
  transaction: a savepoint that rolls back runs it at once — what it cleans up after is gone, even if the transaction
  around it commits — and one that commits hands it to the transaction around it. Outside a transaction it never runs.
  If it fails, `transaction()` throws a `SuppressedError` (`error`: the failure, `suppressed`: the error that rolled back).
- **Explicit transactions stay possible.** `repository.using(trx)` and `queue.using(trx)` bind to a transaction you
  control yourself — Kysely's `db.startTransaction()`, a second connection at the same time, code outside the call chain.
  The callback of `connections.transaction()` receives the Kysely transaction for exactly that. Kysely's own
  `db.transaction().execute(cb)` is not ambient: inside it, only `trx` (or `using(trx)`) is in the transaction.

### What joins, what does not

| Inside `transaction()`                                  | Behaviour                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| repositories, `connections.get()`, `Database`           | join the transaction of their connection                         |
| `queue.dispatch()` on the `database` queue (same connection) | a row in the transaction: visible with the commit, gone with a rollback — deliberately (E85) |
| `queue.dispatch()` on `sync` or any other queue         | held until the outermost commit, dropped on a rollback; a `sync` job then runs outside the transaction |
| in-process event listeners                              | run inside the transaction                                       |
| queued listeners (`static queue`, E86, E109)            | dispatched like `queue.dispatch()` — on the `database` queue a row in the transaction, elsewhere held until the commit; there is no `afterCommit` option |
| `mailer.queue(mail)`                                    | like `queue.dispatch()`: the composed, encrypted mail is a job (`bespoke.mail`) |
| `notifications.send()` / `sendNow()`                    | `send` like `queue.dispatch()` (a `bespoke.notification` job); `sendNow` writes its row (and queues its mail) inside it |
| `broadcast.refresh()` (`@bespokecore/live`)            | sent once the outermost transaction committed (`afterCommit`), nothing after a rollback — no tab reloads what is not there yet |
| the database cache store — rate limits, locks —, the database session store and `temporary_uploads` (uploads, `UPLOADS_CONNECTION`) | **never join** (E108): their own connection, see below — a used upload token stays used after a rollback |
| `afterResponse.defer()`, terminate hooks                | run after the response, outside of any transaction               |
| a job (worker, `sync`, `app.queue.work()`)              | runs outside of any transaction                                  |
| another request, job or test running at the same time  | never sees it                                                    |

### How it works — and its limits

The transaction context is kept in `AsyncLocalStorage` (the decision E107 allows it for request/job context, logging and
this). It follows **one async call chain**: whatever the callback awaits, and the promises and timers it creates. It
never crosses into another request, job or test running at the same time, and the framework cuts it at its own
boundaries (work after the response, jobs, the worker; the helper is `outsideTransaction`). The context records only
*which* transaction is open — never data or services.

The database driver hands the transaction's connection to every query of the call chain; on SQLite, the connection lock
(Kysely's, moved into the driver) is held by the transaction, so queries inside it do not wait for themselves. In a test
with `database: 'refresh'`, transactions are savepoints in the test's transaction; concurrent ones take turns on the one
connection.

## Infrastructure connections (E108)

Some writes must never be part of the app's transaction: a rate-limit counter (a failed login counted inside a
transaction that rolls back would be uncounted — a throttle bypass), a lock (invisible to other processes until the
commit), a session. `connections.infrastructure(name, usage)` is the handle the cache's and the session's database stores
use — a connection that never joins an ambient transaction:

| Connection | `connections.infrastructure()` gives | Inside an open transaction of the app |
| ---------- | ------------------------------------ | -------------------------------------- |
| Postgres | a small pool of its own to the same database, opened on first use (`DB_INFRA_POOL_MAX`, default 4; `infrastructurePoolMax` for a `defineConnection`) | works — its writes are committed at once and survive the rollback |
| SQLite, a file of its own (a `defineConnection` the store names: `CACHE_CONNECTION=system`) | that file | works — nobody else's transaction holds it |
| SQLite, the app's file | the file's one connection, shared (Kysely's lock) | every statement throws `InfrastructureTransactionError`, which says what to do — never a silent join, never a hang |
| a test's isolated connection (`database: 'refresh'`) | the one isolated connection | throws like on SQLite; outside transactions it works and is rolled back with the test |

Why the pool of its own on Postgres: transactions that wait for a rate limit hold their connections — with one shared
pool, enough of them at once would leave none for the rate limit, and wait forever. Why not a second connection on
SQLite: it would wait for the open transaction's write lock — forever, if that transaction waits for it (node:sqlite
blocks the process while it waits). Never point two connection names at one SQLite file (the handle refuses inside a
transaction of either).

The handle runs single statements — no transactions of its own. The queue is deliberately **not** on it: a dispatch is a
row in the transaction (E85, E107), visible with the commit, gone with a rollback. (Laravel's database cache and session
drivers use the app's connection by default and join its transactions.)

## Migrations on another connection

A migration runs on another connection with `connection` — a name, or a function that reads it from the configuration
when the migration runs, so a table lands where the code that uses it looks:

```ts
export default defineMigration({
  connection: cacheTablesConnection,          // (c) => CACHE_CONNECTION with the database driver, else 'default'
  up: async (schema) => { await schema.create('cache', …); },
  down: async (schema) => { await schema.drop('cache'); },
});
```

The record of the migration stays on `default` (one order, one batch number for all); the table's owner and its secret
columns are kept on the connection the table is on, so `selectAll()` there never returns a secret column. A migration on
another connection runs in a transaction of that connection, then is recorded — two databases, two transactions.
`migrate:fresh` drops the tables of every connection a migration runs on. `bespoke db:types` runs every migration on one
scratch database: the generated `Tables` know every table, wherever it lives.
