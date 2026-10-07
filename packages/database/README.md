# @marmeon/database

Data access on [Kysely](https://kysely.dev) (E6): connections (`Connections`, the typed `Database`), migrations per module,
table types generated from the migrations (`marmeon db:types`), repositories, relations without lazy loading, pagination,
factories, seeders — and transactions that everything awaited inside joins (E107). SQLite runs on Node's built-in
`node:sqlite` (no native addon); Postgres needs `pg` (an optional peer: `pnpm add pg@^8`).

**Dependencies** ([the driver rule, E198](../../CONTRIBUTING.md#dependencies-of-drivers)): SQLite is built in, so `pg` — one of several drivers — is an optional peer; without it
`DB_CONNECTION=pgsql` fails with the exact command (`pnpm add pg@^8`).

```ts
// modules/user-profile/controllers/ListUsersController.ts — constructor(users: UserRepository)
export const ListUsersRequest = defineRequest({ query: v.object(pageQuery({ perPage: [25, 50, 100] })) });

static request = ListUsersRequest;
handle(ctx: ContextOf<typeof ListUsersRequest>) {   // ctx.query: { page: number; per_page: 25 | 50 | 100 }
  return this.#users.paginate(this.#users.query().select(['id', 'name']).orderBy('name').orderBy('id'), ctx.query);
}
```

`marmeon discover` registers its `DatabaseServiceProvider` through the `"marmeon"` field of its package.json: `Connections` and
the default `Database` (singletons), the `db:*` and `migrate*` commands (when `marmeon` is installed), a readiness
check and the "run the pending migrations" solution of the error page (E130). Every connection is closed on shutdown.

```text
marmeon migrate [--force] [--no-types] | migrate:rollback [--step=<n>] [--force] | migrate:reset [--force]
marmeon migrate:fresh [--seed] [--force] [--no-types] | migrate:status | db:types [--check] | db:show [--database=<connection>]
marmeon db:seed [--module=<module>] [--class=<Seeder>] [--force] | make:migration <snake_case_name> --module=<module>
```

## Configuration

The default connection reads Laravel's variables (`DatabaseConfig`, checked at the start like all configuration):

```sh
DB_CONNECTION=sqlite                  # sqlite (default) | pgsql
DB_DATABASE=storage/database.sqlite   # SQLite: the file, relative to the app root (default), or :memory:; Postgres: the database name (default marmeon)
DB_URL=postgres://marmeon:secret@localhost:55432/marmeon   # pgsql: a URL — or DB_HOST (127.0.0.1), DB_PORT (5432), DB_USERNAME (postgres), DB_PASSWORD
DB_POOL_MAX=10                        # pgsql: the app's pool (default 10)
DB_INFRA_POOL_MAX=4                   # pgsql: the infrastructure's own pool — cache, sessions, uploads (default 4, see E108 below)
```

Another connection is a config definition that knows its name — listed in the app's or a module's `config`, its variables
validated at the start. The web app gives the cache and the sessions a SQLite file of their own:

```ts
// config/database.ts — and `config: [SystemDatabase]` in defineApplication({ … })
export const SystemDatabase = defineConnection('system', {
  env: v.object({ SYSTEM_DB_DATABASE: v.optional(v.pipe(v.string(), v.nonEmpty()), 'storage/system.sqlite') }),
  resolve: (env) => ({ driver: 'sqlite', database: env.SYSTEM_DB_DATABASE }),
});
// connections.get('system'); or a Postgres one: resolve: (env) => ({ driver: 'pgsql', url: env.REPORTING_DB_URL, poolMax: 5 })
```

`default` is reserved for `DB_CONNECTION`. An unknown connection name fails at the start with the known ones; `marmeon db:show`
prints where a connection points (password masked) and its tables.

## Migrations

A module lists its migrations directory; files are named `YYYY_MM_DD_HHMMSS_what_it_does.ts` and run in the order of their
timestamps across all modules. `marmeon make:migration create_profile_links_table --module=user-profile` writes one (a name
`create_…_table` creates a table, `add_…_to_…_table` alters one, anything else is blank):

```ts
// modules/user-profile/migrations/2026_10_01_120101_create_profile_links_table.ts — and in defineModule:
// migrations: new URL('./migrations/', import.meta.url)
export default defineMigration({
  up: (schema) =>
    schema.create('profile_links', (table) => {
      table.id();
      table.foreignId('user_id').constrained('users').cascadeOnDelete();
      table.string('label', 60);
      table.string('url', 2048);
      table.timestamps();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('profile_links'),
});
```

- **Schema:** `create`, `alter`, `drop`, `dropIfExists`, `rename`, `hasTable`, `hasColumn`.
- **Columns:** `id()`, `string(name, length = 255)`, `text`, `integer`, `bigInteger`, `float`, `decimal(name, 8, 2)` (read as a
  string), `boolean`, `json`, `uuid`, `binary`, `date`, `timestamp` (milliseconds, read as an ISO-8601 string in UTC),
  `timestamps()` (`created_at`/`updated_at`, set on insert), `softDeletes()` (`deleted_at`), `foreignId(name)` with
  `.constrained(table?, column = 'id')` (`user_id` → `users`) and `.cascadeOnDelete()`/`.nullOnDelete()`/`.restrictOnDelete()`.
  Modifiers: `.nullable()`, `.unique()`, `.primary()`, `.default(value)`, `.useCurrent()`, `.secret()`. On the table:
  `index(columns)`, `unique(columns)`, `dropColumn`, `dropIndex`, `dropUnique`, `renameColumn`.
- **Each migration runs in a transaction of its own** (SQLite and Postgres roll back DDL): a failing one leaves no half-changed
  schema. `migrate` runs every pending one in one batch; `migrate:rollback` undoes the last batch (or `--step=n` migrations),
  `migrate:reset` all of them, `migrate:fresh` drops every table and migrates from scratch (`--seed`: then the seeders).
  A migration without `down` stops a rollback there.
- **Where the app is protected** (E139, E164 — every `NODE_ENV` but `development` and `test`: production, staging and a
  missing `NODE_ENV`) `migrate`, `migrate:rollback`, `migrate:reset`, `migrate:fresh` and `db:seed` refuse without `--force`:
  `The application is protected (staging (protected)). Pass --force to migrate — or, on a development machine, set NODE_ENV=development (in .env or the environment).`
  Each first names the environment it assumed
  (`Environment: staging (protected)`). A deployment runs `marmeon migrate --force` (with `make:docker`'s files a one-off
  container: `docker compose -f compose.production.yaml run --rm web migrate --force`), in the one Node process `marmeon`
  started (E159). On a development machine the `.env`'s `NODE_ENV=development` (E170) needs no `--force` —
  `Environment: development (from .env)`; a server whose `.env` says the same is not protected either, so set `NODE_ENV` in the
  server's environment ([where it comes from](../core/README.md#the-environment-node_env)).
- **Ownership (E20):** the migrator records which module's migration created which table — what module boundaries and
  `db:types` build on.

### Secret columns

`.secret()` marks a column that must never be read by accident — a password hash, a 2FA secret. It is left out of
`Row<'users'>`, and the connection removes it from every `selectAll()` and `returningAll()` result. Reading it is deliberate:

```ts
// modules/auth/UserRepository.ts — the only place that reads the hash
const row = await this.query().where('email', '=', email).selectAll().select((eb) => secret(eb, 'password')).executeTakeFirst();
```

Statements on tables with secret columns are marked `secret: true` on the [query channel](#the-query-channel-e118).

### Migrations on another connection

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
`migrate:fresh` drops the tables of every connection a migration runs on. `marmeon db:types` runs every migration on one
scratch database: the generated `Tables` know every table, wherever it lives.

The framework's own tables (`make:cache-table`, `make:session-table`, `make:queue-table`, `make:notifications-table`,
`make:uploads-table`) are migrations the command writes into an app module — `system` unless `--module` names another (E96):
the tables are the app's.

## Table types: `marmeon db:types`

The types of every table come **from the migrations**, never from the state of a database: `db:types` runs them on a scratch
database of the app's driver (SQLite in memory, or a temporary Postgres database), introspects it and writes
`bootstrap/database.d.ts` — committed, so a type check needs no database. It fills `Tables` (and `TableOwners`, `Modules`) by
declaration merging:

```ts
type User = Row<'users'>;          // as read — secret columns left out; also NewRow<'users'>, RowUpdate<'users'>
```

`migrate` and `migrate:fresh` regenerate the file when migrations ran — with `NODE_ENV=development` only (E164; `--no-types` skips
it). Anywhere else — production, staging, a test — the committed file is final, and the app directory may not be writable (a
container's image, systemd's `ProtectSystem=strict`). `marmeon db:types --check` only compares — for CI: it fails when a migration
changed without regenerating. Column types: `Generated<T>` (filled in by the database), `Timestamp`, `Decimal`, `JsonColumn` (read parsed, written
as `JSON.stringify(value)`), `Secret<T>`.

## Repositories

A repository is an optional base for one table — a data mapper: rows in, rows out; no Active Record, no identity map, no lazy
loading, nothing happens on save that you did not call. Repositories are ordinary injectable classes, registered by their
module's provider (`container.singleton(UserRepository)`):

```ts
// modules/auth/UserRepository.ts
export class UserRepository extends Repository<'users'> {
  static table = 'users' as const;          // the table as a runtime value
  static timestamps = true;                 // update() sets updated_at

  findForLogin(email: string) { return this.query().selectAll().where('email', '=', email).executeTakeFirst(); }
  register(values: { name: string; email: string; password: PasswordHash; locale: string }) {
    return this.tryInsert(values);          // undefined when the unique index already holds the e-mail — race-free
  }
}
```

- **Reads:** `query()` (a Kysely select on the table — soft-deleted rows left out), `find(id)`, `findOrFail(id)` (else a 404,
  `RecordNotFoundError`, without telling the client what was looked up), `exists(id)`, `count()`, `paginate(query, { page, perPage })`,
  `withTrashed()`.
- **Writes:** `insert(values)` and `update(id, values)` return the row as stored; `tryInsert` (`undefined`) and `tryUpdate`
  (`'duplicate'`) catch a unique violation in a savepoint, so a Postgres transaction around them survives; `delete(id)`,
  `forceDelete(id)`, `restore(id)`. Values are exact: a field the table does not have is a type error, also from a variable.
- **Statics:** `table`, `connection` (another connection), `timestamps`, `softDeletes` (`delete()` sets `deleted_at`),
  `routeKey` (default `id`) and `routeKeyPattern` (default: digits for `id` — anything else is a 404 without a query).
- **Route binding:** a repository is a route binder — `users.bind('user', UserRepository)`; scoped to a parent,
  `user.bind('link', ProfileLinkRepository, { scopedBy: 'user' })` finds a link only where its `user_id` is the user's id
  (another user's link id is a 404) — see [route model binding](../router/README.md#route-model-binding).
- **Only the connection:** a repository's constructor takes `Connections` and nothing else — `using(trx)` rebuilds it bound to a
  transaction you control (see [Transactions](#transactions)).

## Queries, module boundaries and relations

`constructor(db: Database)` is the default connection as `Kysely<Tables>`; `connections.get('reporting')` another one; `sql`
(Kysely's template) is re-exported. Module boundaries are opt-in (E20): `Database<'user-profile'>` sees the module's own tables
for everything and the tables other modules expose (`defineModule({ name: 'auth', exposes: ['users'] })`) for reading and joins
only — an `insertInto('users')` there is a type error.

`hasMany`, `hasOne` and `belongsTo` load related rows **in the same query** (JSON aggregation of the dialect) — one query, no
N+1, the selection is the type:

```ts
// modules/user-profile/ProfileDirectory.ts — constructor(db: Database<'user-profile'>)
this.#db.selectFrom('users').selectAll('users').select((eb) => [
  hasOne(eb, 'login_activity', 'user_id', 'users.id', (q) => q.select('login_activity.last_login_at')).as('activity'),
  hasMany(eb, 'profile_links', 'user_id', 'users.id', (q) => q.select(['profile_links.id', 'profile_links.label']).orderBy('profile_links.id')).as('links'),
]).where('users.id', '=', id).executeTakeFirst();
```

`isUniqueViolation(error)` recognizes a unique violation on both drivers; `missingTable(error)` a table that does not exist.

## Pagination

- **`pageQuery({ perPage })`** — the page as query fields, spread into a route's query schema (E55):
  `v.object({ ...pageQuery({ perPage: [25, 50, 100] }), sort: … })` reads `?page=` (a whole number ≥ 1, default 1) and
  `?per_page=` (one of `perPage`, default its first; one number allows just that). Like every query field, an invalid value falls
  back to its default (`?page=-1`, `?per_page=100000`) — never a 422 — and the defaults stay out of URLs the browser builds.
  `ctx.query.per_page` is typed `25 | 50 | 100`; `<Pagination>` of `@marmeon/react` builds its links from the same parsed query.
- **`paginate(db, query, ctx.query)`** (or `repository.paginate(query, ctx.query)`): one page and the total —
  `{ data, meta: { page, perPage, total, lastPage, from, to } }`, the `meta` that `<Pagination>` takes. The count is a second
  query on the same filter. It takes the parsed query of a schema with `pageQuery()` — a query without a page is a type error
  ("this query has no page — spread pageQuery() into the route's query schema …") — or `{ page, perPage }` written out.
- **`paginationFrom(query, { perPage = 15, maxPerPage = 100 })`** — *deprecated since Wave 9*: reads `?page=` and `?per_page=`
  safely from the search params (or a parsed query object). Use `pageQuery()` and hand `paginate` the parsed `ctx.query`.
- **`cursorPaginate(query, { column, key = 'id', cursor, perPage, direction, encrypter })`** — keyset pagination for large tables
  and "load more": no count, no offset, nobody twice while rows are added.
  - **Its own order:** by `column` (one or several), then the unique `key` as the tie-breaker — added by itself, so
    `{ column: 'name' }` orders by `(name, id)`. An `orderBy` of the query is taken out (it would come first).
  - **Nullable columns:** NULLs come last in both directions (`NULLS LAST`, SQLite and Postgres alike), and a row whose value is
    NULL is a cursor like any other — the next page goes on among the NULLs instead of starting over.
  - **Encrypted cursors:** `meta.nextCursor` is the last row's values encrypted and authenticated with the app key — inject
    `Encrypter` (`@marmeon/encryption`) and pass it. A client can neither read a hidden sort column's value from the URL nor
    make up a cursor. Each order has its own encryption context (the columns and the direction): one that does not decrypt —
    changed, made up, of another order, of a key that is gone, or the base64url format before Wave 9 — answers **400**
    (`InvalidCursorError`), never the first page again. (A cursor of another list with the same columns and direction does
    decrypt; it is only a position in this list.)

```ts
constructor(db: Database<'blog'>, encrypter: Encrypter) { … }
const page = await cursorPaginate(this.#db.selectFrom('articles').select(['id', 'title', 'published_at']), {
  column: 'published_at', direction: 'desc', cursor: ctx.query.cursor, perPage: 20, encrypter: this.#encrypter,
});   // by (published_at desc nulls last, id desc)
```

## Factories and seeders

```ts
// modules/auth/factories/UserFactory.ts
export const UserFactory = defineFactory('users', ({ sequence }) => ({
  name: `User ${sequence}`,
  email: `user${sequence}@example.com`,
  password: FACTORY_PASSWORD_HASH,
  bio: '',
  email_verified_at: new Date().toISOString(),
}), { states: { unverified: { email_verified_at: null } } });
```

A factory is typed against the table's insert type — a new `NOT NULL` column makes every factory that misses it a compile
error. `factory(UserFactory).count(3).state('unverified').create({ … })` inserts and returns the stored rows; `make()` only
builds the attributes (no insert — what mail previews use). In a definition, `user_id: factory(UserFactory)` creates the related
row first and uses its id. Sequences are per app, never global.

A seeder is a class with `handle({ factory, db })`, built by the container (constructor injection), listed by its module and
run in module order by `marmeon db:seed` (or `migrate:fresh --seed`):

```ts
// modules/auth/seeders/DemoUsersSeeder.ts — and `seeders: [DemoUsersSeeder]` in defineModule
export class DemoUsersSeeder {
  constructor(hasher: Hasher) { … }
  async handle({ factory }: SeedContext) {
    await factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com', password: await this.#hasher.make('password') });
  }
}
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
`{ isolationLevel }` sets the isolation level of an outermost transaction. `inTransaction()` says whether one is open.

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
| `mailer.queue(mail)`                                    | like `queue.dispatch()`: the composed, encrypted mail is a job (`marmeon.mail`) |
| `notifications.send()` / `sendNow()`                    | `send` like `queue.dispatch()` (a `marmeon.notification` job); `sendNow` writes its row (and queues its mail) inside it |
| `broadcast.refresh()` (`@marmeon/live`)            | sent once the outermost transaction committed (`afterCommit`), nothing after a rollback — no tab reloads what is not there yet |
| the database cache store — rate limits, locks —, the database session store and `temporary_uploads` (uploads, `UPLOADS_CONNECTION`) | **never join** (E108): their own connection, see below — a used upload token stays used after a rollback |
| `afterResponse.defer()`, terminate hooks                | run after the response, outside of any transaction               |
| a job (worker, `sync`, `app.queue.work()`)              | runs outside of any transaction                                  |
| another request, job or test running at the same time  | never sees it                                                    |

The queue's side of this is in [@marmeon/queue](../queue/README.md#transactions-e107-e109).

### How it works — and its limits

The transaction context is kept in `AsyncLocalStorage` (the decision E107 allows it for request/job context, logging and
this). It follows **one async call chain**: whatever the callback awaits, and the promises and timers it creates. It
never crosses into another request, job or test running at the same time, and the framework cuts it at its own
boundaries (work after the response, jobs, the worker; the helper is `outsideTransaction`). The context records only
*which* transaction is open — never data or services.

The database driver hands the transaction's connection to every query of the call chain; on SQLite, the connection lock
(Kysely's, moved into the driver) is held by the transaction, so queries inside it do not wait for themselves. In a test
with `database: 'refresh'`, transactions are savepoints in the test's transaction; concurrent ones take turns on the one
connection. Queries take turns on a connection, too: a `Promise.all` of plain queries inside a transaction (a page's props) or two
requests on a test's connection run one after the other, in the order they were sent — a driver like `pg` must not be sent a query
while another is under way (pg 9 refuses it). A stream (`.stream()`) holds the connection until it ends: inside one, query
another connection.

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
drivers use the app's connection by default and join its transactions.) What this means per store:
[the cache](../cache/README.md#database-its-own-connection-never-the-apps-transactions-e108),
[the sessions](../session/README.md#database).

## The query channel (E118)

Every statement — of every connection, the infrastructure handle included — goes to the `db.query` channel of
[`@marmeon/core/diagnostics`](../core/README.md#diagnostics-marmeoncorediagnostics-e118) while something listens (the
error page, the devtools, `Server-Timing`, OpenTelemetry): `connection`, `driver`, `sql`, `parameters`, `durationMs`, `error`,
and the request (`requestId`) or job (`jobId`) it ran in.
**`secret: true`** marks a statement that touches a table with secret columns (`.secret()` in its migration) — every
table the query builder names, and for raw SQL any secret table's name in its text. Its parameters may hold a password
hash or a token: whatever records or shows queries redacts them all ([redaction, E125](../core/README.md#redaction-e125)).
Without a subscriber nothing is built. `connections.onQuery(listener)` stays for code that counts queries itself (tests).
OpenTelemetry ([@marmeon/otel](../otel/README.md)) records a statement as a client span with its text only — never its
parameters.

**Readiness (E126):** the provider registers `DatabaseHealthCheck` for `/up/ready` — `select 1` on every configured connection
(the app's pools, as requests use them); one that fails makes the instance "not ready" and says which
([health checks](../core/README.md#health-checks-e126)).

## Testing

With `@marmeon/testing`, `createTestApp(App, { database: 'refresh' })` gives a real database, reset for every test
(Laravel's `RefreshDatabase`, E21): each test worker gets its own — a temporary SQLite file, or a Postgres database named after
the app's with `_test_<app hash>_<worker>` — migrated once; every test app runs inside one transaction that is rolled back when the test
ends. `seed: true` also runs the modules' seeders for every test. More in [the database](../testing/README.md#the-database).

```ts
const app = await createTestApp(application, { database: 'refresh' });
const ada = await app.factory(UserFactory).create();
const link = await app.factory(ProfileLinkFactory).create({ user_id: ada.id });
await app.actingAs(ada).delete(`/users/${ada.id}/links/${link.id}`);
await app.assertDatabaseMissing('profile_links', { id: link.id });   // also assertDatabaseHas, assertDatabaseCount
```

`pnpm test:pgsql` runs the suite against Postgres (`docker compose up -d` starts one on port 55432).
