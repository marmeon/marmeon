# Database: Getting Started

## Introduction

Almost every app keeps its data in a database. Marmeon talks to it through [Kysely](https://kysely.dev), a query builder that
knows every table and column of your app as a type. A new app runs on SQLite, which Node brings along, so there is nothing to
install and no server to start. Postgres works the same way once you install its driver.

The default connection is a service. Ask for `Database` in a constructor and query it:

```ts title="modules/notes/controllers/ListNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Database } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';

export class ListNotesController extends Controller {
  readonly #db: Database;

  constructor(db: Database) {
    super();
    this.#db = db;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const notes = await this.#db
      .selectFrom('notes')
      .select(['id', 'title', 'updated_at'])
      .where('user_id', '=', ctx.user.id)
      .orderBy('updated_at', 'desc')
      .execute();
    return this.view('notes/Index', { notes });
  }
}
```

The table names, the columns and the result's type come from your [migrations](migrations.md). A misspelt column is a compile
error, and `notes` is typed as a list of `{ id, title, updated_at }`. The [repositories and queries](queries.md) page shows how to
write queries, and how a repository keeps them in one place.

## Configuration

The default connection reads these variables, checked when the app starts like all [configuration](configuration.md):

| Variable | Default | Effect |
| --- | --- | --- |
| `DB_CONNECTION` | `sqlite` | The driver: `sqlite` or `pgsql`. |
| `DB_DATABASE` | `storage/database.sqlite` for SQLite, `marmeon` for Postgres | SQLite: the file, relative to the app's root, or `:memory:`. Postgres: the database's name. |
| `DB_HOST` | `127.0.0.1` | Postgres: the server. |
| `DB_PORT` | `5432` | Postgres: its port. |
| `DB_USERNAME` | `postgres` | Postgres: the user. |
| `DB_PASSWORD` | empty | Postgres: the password. |
| `DB_URL` | none | Postgres: the whole address instead, `postgres://user:secret@host:5432/app`. |
| `DB_POOL_MAX` | `10` | Postgres: the most connections the app's pool opens. |
| `DB_INFRA_POOL_MAX` | `4` | Postgres: the most connections of the small pool the cache, the sessions and uploads use. See [infrastructure connections](#infrastructure-connections). |

A Postgres server is either the five variables `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` and `DB_PASSWORD`, or its
whole address in `DB_URL`. When `DB_URL` is set, it wins: the five are not read. `DB_URL` must start with `postgres://` or
`postgresql://`, and the start fails with every wrong value named at once.

```sh title=".env"
DB_CONNECTION=pgsql
DB_HOST=db.internal
DB_PORT=5432
DB_DATABASE=notes
DB_USERNAME=notes
DB_PASSWORD=secret
```

### SQLite

SQLite runs on `node:sqlite`, which is part of Node: no native addon, nothing to build. The file is created on the first query.
Its directory must exist, so the app checks it when it starts and stops with the path when it is missing:

```text
[marmeon:D11] The directory of the SQLite database for connection "default" does not exist: /srv/app/storage (sqlite storage/database.sqlite).
```

A file database runs in WAL mode, so the development server and a command such as `migrate` can work at the same time. A
statement that finds the file locked waits up to five seconds before it fails. `DB_DATABASE=:memory:` keeps the database in
memory, which the `.env.test` of a new app does for its tests.

SQLite has one writer at a time, and the app's file has one connection. The [transactions](transactions.md) page explains what
that means inside a transaction.

### Postgres

Postgres needs the `pg` driver in your app:

```sh
pnpm add pg@^8
```

Install it as a dependency, not a dev dependency. Without it, the first query fails and names the command. With
`DB_URL=postgres://app:secret@db:5432/app`, the message reads:

```text
[marmeon:D11] Could not connect to the database connection "default" (pgsql postgres://app:***@db:5432/app): DB_CONNECTION=pgsql needs the "pg" package, which is not installed in this app: pnpm add pg@^8
```

A connection of your own names itself instead: `The Postgres connection "reporting" needs the "pg" package, …`.

The app does not connect to Postgres when it starts, so a command that sends no query works without a running server. The first
query connects, and a deployment's `marmeon migrate --force` is that first query, so it finds a missing driver or a wrong address
before any request does. The [deployment](deployment.md#drivers-what-an-app-installs) page lists every driver an app may need.

Values come back as the same JavaScript types on both drivers, so code and tests do not change with the database:

- A `bigint` column is read as a `number`. A value beyond `Number.MAX_SAFE_INTEGER` throws a `RangeError` instead of losing
  digits. Cast it to text in the query if you need such numbers.
- A timestamp is read as an ISO-8601 string in UTC, such as `2026-10-01T12:00:00.000Z`. The connection runs in UTC.
- A `date` is read as `YYYY-MM-DD`, as stored.

An error message names the connection and where it points, with the password masked. When the server drops an idle connection,
the pool replaces it and the log says so with a warning.

## More connections

Another database is a definition with a name. It reads its own variables, which are checked at the start like all
configuration. This one gives the cache and the sessions a SQLite file of their own:

```ts title="config/database.ts"
import { env } from '@marmeon/core';
import { defineConnection } from '@marmeon/database';

export const SystemDatabase = defineConnection('system', {
  env: env({
    SYSTEM_DB_DATABASE: env.string().default('storage/system.sqlite'),
  }),
  resolve: (e) => ({ driver: 'sqlite', database: e.SYSTEM_DB_DATABASE }),
});
```

List the definition in `config` of `defineApplication()` in `bootstrap/app.ts`, or of the module that needs it. `resolve`
returns `{ driver: 'sqlite', database }` or a Postgres server. Like the default connection, a Postgres server is its parts, `host`,
`port`, `database`, `username` and `password`, or the whole address in `url`, which wins when both are given. Without `url`, the
parts default to `127.0.0.1`, `5432`, `postgres` and no password, and `database` is required. `poolMax` and
`infrastructurePoolMax` size its pools, 10 and 4 by default. A reporting database that reads both ways:

```ts title="config/reporting.ts"
import { env } from '@marmeon/core';
import { defineConnection } from '@marmeon/database';

export const ReportingDatabase = defineConnection('reporting', {
  env: env({
    REPORTING_DB_HOST: env.string().default('127.0.0.1'),
    REPORTING_DB_PORT: env.port().default(5432),
    REPORTING_DB_DATABASE: env.string().default('reporting'),
    REPORTING_DB_USERNAME: env.string().default('postgres'),
    REPORTING_DB_PASSWORD: env.string().default(''),
    REPORTING_DB_URL: env.url({ protocols: ['postgres', 'postgresql'] }).optional(),
  }),
  resolve: (e) => ({
    driver: 'pgsql',
    url: e.REPORTING_DB_URL,
    host: e.REPORTING_DB_HOST,
    port: e.REPORTING_DB_PORT,
    database: e.REPORTING_DB_DATABASE,
    username: e.REPORTING_DB_USERNAME,
    password: e.REPORTING_DB_PASSWORD,
    poolMax: 5,
  }),
});
```

`default` is the name of the connection of `DB_CONNECTION`, and `defineConnection('default', …)` throws. Ask `Connections` for any
connection by its name:

```ts title="modules/reports/MonthlyReport.ts"
import { Connections, type Connection } from '@marmeon/database';
import type { ReportingTables } from './tables.ts';

export class MonthlyReport {
  readonly #reporting: Connection<ReportingTables>;

  constructor(connections: Connections) {
    this.#reporting = connections.get<ReportingTables>('reporting');
  }

  totals() {
    return this.#reporting.selectFrom('orders').select(['month', 'total']).orderBy('month').execute();
  }
}
```

Without a type argument, `get()` types the connection with your app's tables. A name that no definition has throws at once, with
the names it knows:

```text
[marmeon:D11] Database connection "reporting" is not configured. Known: default, system. Add one with defineConnection('reporting', …) in the app's config.
```

Connections open on their first query and close when the app shuts down.
[Migrations](migrations.md#migrations-on-another-connection) and [repositories](queries.md#another-connection) can work on another
connection too.

## Infrastructure connections

Some writes must never be part of your app's transaction. A failed sign-in counted inside a transaction that rolls back would be
uncounted, and the next guess would get through. A lock taken inside one would be invisible to other processes until the commit.
So the database drivers of the [cache](cache.md#the-database-driver-and-transactions), the
[sessions](session.md#the-database-driver) and [uploads](storage.md#the-uploads-table) write on a connection that never joins a
transaction:

| Their connection | What they get | Inside an open transaction of the app |
| --- | --- | --- |
| Postgres | A small pool of its own to the same database, opened on first use: `DB_INFRA_POOL_MAX` connections, or `infrastructurePoolMax` of a `defineConnection()`. | Works. Their writes are committed at once and survive a rollback. |
| SQLite, a file of its own | That file. | Works. |
| SQLite, the app's own file | The file's one connection, shared. | Every statement throws an `InfrastructureTransactionError`, which says what to do. |

The pool of its own on Postgres keeps transactions that wait for a rate limit from taking every connection that the rate limit
needs. On SQLite a second connection to the app's file would wait for the open transaction's lock, forever if the transaction
waits for it. So on SQLite give the cache, the sessions and uploads a file of their own, as `config/database.ts` above does,
and point them at it with `CACHE_CONNECTION=system`, `SESSION_CONNECTION=system` and `UPLOADS_CONNECTION=system`. Outside a
transaction the app's own file works as well. Never point two connection names at the same SQLite file: a transaction of either
holds the file for both. On Postgres there is nothing to configure.

## Kysely and its version

The query builder is [Kysely](https://kysely.dev), and the framework pins it to one exact version. You write its builder through
`@marmeon/database` and never install or import the `kysely` package yourself, so the app and the framework use the same copy.
A Kysely update that changes the builder's shape comes only in a major version of Marmeon. The
[releases](releases.md#libraries-the-framework-builds-on) page lists what else it promises.

## Inspecting a connection

`marmeon db:show` prints where a connection points, its server's version and its tables with their number of columns and rows:

```sh
pnpm marmeon db:show
pnpm marmeon db:show --database=system
```

The password in the address is masked. `--database` names a connection, `default` without it.

The target shows the host, port and database, the user name, and of the query string only `host`, `port`, `sslmode` and
`application_name`. The password, every other parameter (a key path, an `options` string) and the fragment never reach the output,
whether the address came from `DB_URL`, from `DB_PASSWORD` or from a connection's `password` option.

`--json` prints a [machine-readable document](console.md#machine-readable-output): `format`, `connection`, `driver` (`sqlite` or
`pgsql`), `target` (as in the text, without the driver in front), `server`, `tables` (each with `name`, `schema` — `null` for
SQLite — `columns` and `rows`) and `warnings`.

## When a table is missing

A query on a table that does not exist yet fails like any error. In development, the error page names the cause: the migrations
that have not run yet, and the command that runs them, `marmeon migrate`. When every migration has run, it suggests a migration
that creates the table. The [migrations](migrations.md) page explains both commands.

## Readiness

The app's readiness check, `/up/ready`, sends `select 1` to every configured connection. One that does not answer makes the
instance "not ready" and is named in the answer. The [health checks](health.md#liveness-and-readiness) page explains readiness.

## Testing

`createTestApp(application, { database: 'refresh' })` of `@marmeon/testing` gives each test a real database, migrated once and
rolled back after every test. The [database testing](database-testing.md#how-the-database-is-reset) page explains it.
