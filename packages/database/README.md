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

  Note that a rate limiter or lock on the **database** cache store joins a transaction like every other write on the
  connection (as in Laravel): a counter written inside a transaction that rolls back is rolled back with it.
- **Explicit transactions stay possible.** `repository.using(trx)` and `queue.using(trx)` bind to a transaction you
  control yourself — Kysely's `db.startTransaction()`, a second connection at the same time, code outside the call chain.
  The callback of `connections.transaction()` receives the Kysely transaction for exactly that. Kysely's own
  `db.transaction().execute(cb)` is not ambient: inside it, only `trx` (or `using(trx)`) is in the transaction.

### What joins, what does not

| Inside `transaction()`                                  | Behaviour                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| repositories, `connections.get()`, `Database`           | join the transaction of their connection                         |
| `queue.dispatch()` on the `database` queue (same connection) | a row in the transaction: visible with the commit, gone with a rollback |
| `queue.dispatch()` on `sync` or any other queue         | held until the outermost commit, dropped on a rollback; a `sync` job then runs outside the transaction |
| in-process event listeners                              | run inside the transaction                                       |
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
