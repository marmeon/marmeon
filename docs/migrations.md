# Migrations

## Introduction

Migrations are the history of your database's schema, kept as code next to the module that owns the tables. Each one changes the
schema a step forward and knows how to take that step back. Everyone who checks out the app runs the same steps, and your table
types are generated from them.

```ts title="modules/notes/migrations/2026_10_01_120000_create_notes_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('notes', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('title', 200);
      table.string('slug', 80).unique();
      table.text('body');
      table.boolean('shared').default(false);
      table.timestamp('published_at').nullable();
      table.timestamps();
      table.index('user_id');
    }),
  down: (schema) => schema.drop('notes'),
});
```

`pnpm marmeon migrate` creates the table. In development it also writes the table's type into `bootstrap/database.d.ts`, so the
next line of code that queries `notes` knows every column.

## Generating migrations

`make:migration` writes a migration into a module:

```sh
pnpm marmeon make:migration create_notes_table --module=notes
pnpm marmeon make:migration add_archived_at_to_notes_table --module=notes
```

The name decides what the file starts with. `create_…_table` creates a table with an id and timestamps. A name that ends in
`_to_…_table`, `_from_…_table` or `_in_…_table` changes that table. Any other name gives an empty migration. The name must be
snake_case, and `--module` must name a module that exists.

The file is named after the time it was made, `2026_10_01_120000_create_notes_table.ts`, and always after the module's latest
migration. A module lists the folder of its migrations once, and the command prints the line when it is missing:

```ts title="modules/notes/index.ts"
import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'notes',
  migrations: new URL('./migrations/', import.meta.url),
  routes,
});
```

Migrations run in the order of their file names across all modules, so the timestamp decides. The starter kit's migrations start
with `0001_01_01_` and come before any you write. A `.ts` or `.js` file in the folder whose name does not fit the pattern stops
every migration command with the name it expects, and so do two migrations with the same name and a module whose `migrations`
folder does not exist.

## Migration structure

A migration file exports `defineMigration({ up, down })`. `up` makes the change, and `down` undoes it. Both receive a `Schema`:

| Method | What it does |
| --- | --- |
| `schema.create(table, build)` | Creates a table. `build` describes its columns and indexes. |
| `schema.alter(table, build)` | Changes a table: new columns, indexes, renamed and dropped columns. |
| `schema.drop(table)` | Drops a table. |
| `schema.dropIfExists(table)` | Drops a table if it is there. |
| `schema.rename(from, to)` | Renames a table. |
| `schema.hasTable(table)` | Whether a table exists. |
| `schema.hasColumn(table, column)` | Whether a table has a column. |
| `schema.db` | The connection, inside the migration's transaction: for data changes and anything the schema methods do not cover. |
| `schema.driver` | `'sqlite'` or `'pgsql'`. |

A migration that moves data uses `schema.db` like any Kysely connection. Its tables are typed loosely here, because a migration
runs against the schema of its own time, not the one `bootstrap/database.d.ts` describes today:

```ts title="modules/notes/migrations/2026_10_05_090000_fill_note_slugs.ts"
import { defineMigration, sql } from '@marmeon/database';

export default defineMigration({
  up: async (schema) => {
    await schema.db.updateTable('notes').set({ slug: sql`'note-' || id` }).where('slug', '=', '').execute();
  },
});
```

A migration without `down` cannot be rolled back. A rollback that reaches it stops there with an error that names it.

## Running migrations

| Command | What it does |
| --- | --- |
| `marmeon migrate` | Runs every pending migration, in one new batch. |
| `marmeon migrate:status` | Lists every migration, with its batch or `Pending`. |
| `marmeon migrate:rollback` | Undoes the last batch. `--step=3` undoes the last three migrations instead, whatever their batch. |
| `marmeon migrate:reset` | Undoes every migration. |
| `marmeon migrate:fresh` | Drops every table and runs every migration again. `--seed` runs the [seeders](seeding.md) afterwards. |

**Each migration runs in a transaction of its own.** SQLite and Postgres both roll back a schema change, so a migration that fails
leaves no half-changed table behind, and it is not recorded. The migrations before it in the same run stay done.

`migrate` and `migrate:fresh` write the table types afterwards when migrations ran, with `NODE_ENV=development` only. `--no-types`
skips that. `migrate:rollback` and `migrate:reset` do not write them: after a rollback, run `marmeon db:types` to bring the file
back in line. The [repositories and queries](queries.md#table-types) page explains the file.

A rollback needs the file of every migration it undoes. One whose file is gone stops it with an error that names the migration.

> [!WARNING]
> `migrate:fresh` drops **every** table of the database, also tables that no migration created, and every table of the other
> connections that migrations run on. Use it on a development database only.

### Where the app is protected

Outside development and tests the app is protected: in production, whatever `APP_ENV` names it, and when `NODE_ENV` is not set
at all. There `migrate`, `migrate:rollback`, `migrate:reset`, `migrate:fresh` and `db:seed` refuse to run without `--force`. Each
command first names the environment it assumed, here on a staging server:

```text
Environment: production (APP_ENV=staging)
The application is protected (production (APP_ENV=staging)). Pass --force to migrate — or, on a development machine, set NODE_ENV=development (in .env or the environment).
```

A deployment runs `marmeon migrate --force` once, before the new version takes requests. The
[deployment](deployment.md#the-short-version) page shows it in a one-off container. On your machine, `NODE_ENV=development` in
`.env` needs no `--force`, and the line reads `Environment: development (APP_ENV=local, NODE_ENV from .env)`. The
[configuration](configuration.md#where-node_env-comes-from) page explains where `NODE_ENV` comes from.

## Columns

| Method | Postgres | SQLite | Read as |
| --- | --- | --- | --- |
| `id(name = 'id')` | `bigint`, generated | `integer`, autoincrement | `number` |
| `string(name, length = 255)` | `varchar(length)` | `varchar(length)` | `string` |
| `text(name)` | `text` | `text` | `string` |
| `integer(name)` | `integer` | `integer` | `number` |
| `bigInteger(name)` | `bigint` | `integer` | `number`, and a value beyond `Number.MAX_SAFE_INTEGER` throws |
| `float(name)` | `double precision` | `real` | `number` |
| `decimal(name, precision = 8, scale = 2)` | `numeric(8, 2)` | `numeric(8, 2)` | a string, such as `'12.50'` |
| `boolean(name)` | `boolean` | `boolean` | `true` or `false` |
| `json(name)` | `jsonb` | `json` | the parsed value |
| `uuid(name)` | `uuid` | `uuid` | `string` |
| `binary(name)` | `bytea` | `blob` | `Uint8Array` |
| `date(name)` | `date` | `date` | `'YYYY-MM-DD'` |
| `timestamp(name)` | `timestamptz(3)` | `datetime` | an ISO-8601 string in UTC, to the millisecond |
| `foreignId(name)` | `bigint` | `integer` | `number` |

Two shortcuts add common columns. `timestamps()` adds `created_at` and `updated_at`, both set to the current time on insert.
`softDeletes()` adds a nullable `deleted_at` for a repository with `static softDeletes = true`. Defining the same column twice
throws.

### Modifiers

A column is `NOT NULL` unless you say otherwise:

| Modifier | Effect |
| --- | --- |
| `.nullable()` | Allows `NULL`. The column's type gains `\| null`. |
| `.default(value)` | A default for inserts. The value must fit the column's type, and a JSON default is a value: `.default({})`. |
| `.useCurrent()` | On a timestamp: the time of the insert is the default. |
| `.unique()` | A unique index on this column, named `{table}_{column}_unique`. |
| `.primary()` | The primary key. |
| `.secret()` | A column that is never read by accident. See [secret columns](#secret-columns). |

A column with a default, or a generated id, is optional on insert: its type is `Generated<…>`. The compiler holds the modifiers to
their columns. A default that does not fit the column, `NULL` as the default of a column that is not nullable, and `useCurrent()`
on anything but a timestamp are compile errors.

### Foreign keys

`foreignId()` adds the column, `constrained()` the reference, and one more call decides what happens when the referenced row is
deleted:

```ts title="modules/notes/migrations/2026_10_02_080000_create_attachments_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('attachments', (table) => {
      table.id();
      table.foreignId('note_id').constrained().cascadeOnDelete();
      table.foreignId('uploaded_by').constrained('users').nullOnDelete().nullable();
      table.string('name');
      table.timestamps();
    }),
  down: (schema) => schema.drop('attachments'),
});
```

`constrained()` guesses the table from the column's name, `note_id` → `notes`, and references its `id`. Name both when the guess
is wrong: `constrained('users', 'id')`. Then `cascadeOnDelete()` deletes the row along with the referenced one, `nullOnDelete()`
sets the column to `NULL`, and `restrictOnDelete()` refuses to delete the referenced row while this one points at it. Without any
of them, the database's default applies and refuses the delete as well. The compiler only offers the three after
`constrained()`, and `.nullable()` goes last, as in `uploaded_by` above. Both SQLite and Postgres enforce the reference.

### Indexes

`table.index(columns)` adds an index and `table.unique(columns)` a unique index, over one column or a list. Their names are
`{table}_{columns}_index` and `{table}_{columns}_unique`, joined by underscores, unless you pass a name as the second argument.

The unique index is what keeps a value unique when two requests insert at the same moment. A validation rule only gives the
friendly message before the insert. The [validation](validation.md#the-unique-index-is-the-truth) page shows both together.

## Changing tables

`schema.alter()` takes the same column methods as `create()`, and a few more:

```ts title="modules/notes/migrations/2026_10_06_100000_add_archived_at_to_notes_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.alter('notes', (table) => {
      table.timestamp('archived_at').nullable();
      table.renameColumn('body', 'content');
      table.index('archived_at');
    }),
  down: (schema) =>
    schema.alter('notes', (table) => {
      table.dropIndex('notes_archived_at_index');
      table.renameColumn('content', 'body');
      table.dropColumn('archived_at');
    }),
});
```

| Method | What it does |
| --- | --- |
| `table.dropColumn(name)` | Drops a column. |
| `table.renameColumn(from, to)` | Renames a column. |
| `table.dropIndex(name)` | Drops an index by its name. |
| `table.dropUnique(name)` | Drops a unique index by its name. |

These four work in `alter()` only, and `create()` throws when it finds them. Each change runs as a statement of its own, because
SQLite changes a table one step at a time. The order is fixed, whatever order you write them in: dropped indexes first, then
renamed columns, new columns, new indexes, and dropped columns last. So dropping a column and adding one of the same name needs
two `alter()` calls. Two rules come from SQLite as well: a new `NOT NULL` column needs a default, and a column with an index
cannot be dropped before its index.

## Secret columns

`.secret()` marks a column that must never be read by accident: a password hash, a token's hash, a two-factor secret. The
starter kit's `users` table marks its password:

```ts title="modules/auth/migrations/0001_01_01_000000_create_users_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('users', (table) => {
      table.id();
      table.string('name');
      table.string('email').unique();
      table.string('password').secret();
      table.timestamp('email_verified_at').nullable();
      table.string('locale', 35).nullable();
      table.timestamps();
    }),
  down: (schema) => schema.drop('users'),
});
```

A secret column is written like any other, but:

- `Row<'users'>` leaves it out, so it cannot reach a page's props by accident;
- the connection removes it from every `selectAll()` and `returningAll()` result, also inside a subquery;
- a query names it on purpose with `secret(eb, 'password')`, in the one place that needs it.

The starter kit's `UserRepository` is that place. It checks a password at sign-in, and the hash travels next to the user, never
inside it:

```ts
const row = await this.query().where('email', '=', email).selectAll().select((eb) => secret(eb, 'password')).executeTakeFirst();
```

`secret` comes from `@marmeon/database`. Raw SQL is not checked, so `` sql`select * from users` `` returns the hash. Statements on
a table with secret columns are marked as such for whatever records queries, which then leaves their parameters out. The
[observability](observability.md#queries-and-secret-columns) page explains it.

## Migrations on another connection

A migration runs on another connection with `connection`: a name, or a function that reads the name from the app's configuration
when the migration runs. So a table lands where the code that uses it looks:

```ts title="modules/reports/migrations/2026_10_07_110000_create_report_runs_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  connection: 'reporting',
  up: (schema) =>
    schema.create('report_runs', (table) => {
      table.id();
      table.string('report');
      table.timestamps();
    }),
  down: (schema) => schema.drop('report_runs'),
});
```

- **One order.** The record of every migration stays on `default`, with one batch number for all of them.
- **Two transactions.** The migration runs in a transaction of its own connection and is recorded afterwards. A migration that
  fails is not recorded.
- **Its table's books stay with the table.** Which module owns it and which columns are secret is kept on the connection the
  table is on, so a `selectAll()` there leaves the secret columns out too.
- `migrate:fresh` drops the tables of every connection a migration runs on.
- `db:types` runs every migration on one scratch database, so `Tables` knows every table, wherever it lives.

A connection that is not configured stops the migration with the names of the known ones.

## The framework's tables

Some drivers need a table: the database cache, sessions and queue, notifications and uploads. A command writes its migration into
your app, so the table is yours to change like any other:

```sh
pnpm marmeon make:cache-table
pnpm marmeon migrate
```

| Command | Tables |
| --- | --- |
| `make:cache-table` | `cache`, `cache_locks`, on the cache's connection |
| `make:session-table` | `sessions`, on the sessions' connection |
| `make:queue-table` | `jobs`, `failed_jobs`, on the queue's connection |
| `make:notifications-table` | `notifications`, on the notifications' connection |
| `make:uploads-table` | `temporary_uploads`, on the uploads' connection |

Each writes into the `system` module, or the module that `--module` names. The command creates the `system` module and adds it
to `bootstrap/app.ts` when it does not exist yet. It refuses when any module already has a migration for the table. Each migration
reads its connection from the configuration when it runs: `CACHE_CONNECTION`, `SESSION_CONNECTION`, `DB_QUEUE_CONNECTION`,
`NOTIFICATIONS_CONNECTION` and `UPLOADS_CONNECTION`. So its tables land on the
[connection](database.md#infrastructure-connections) the driver reads and writes.

The queue's migration creates `failed_jobs` next to `jobs`. With `QUEUE_FAILED_CONNECTION` set to another connection, it stops
with a message instead of creating the table where nothing looks. Move the `failed_jobs` part into a migration of its own with
that `connection`, as in [migrations on another connection](#migrations-on-another-connection).
