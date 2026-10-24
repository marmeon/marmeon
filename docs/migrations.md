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
migration. A module lists the folder of its migrations once; the command adds it to the module's `index.ts` when it is missing (or prints the
line when the file has another shape or you pass `--no-register`):

```ts title="modules/notes/index.ts"
import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'notes',
  migrations: new URL('./migrations/', import.meta.url),
  routes,
});
```

Migrations run in the order of their file names across all modules, character by character, so the timestamp decides. The
"after the module's latest migration" above holds within one module only: `make:migration` looks at the folder it writes
to. A foreign key from one module's table to another's (`bookings.room_id` to `rooms`) therefore needs the referenced table
to be created first, in time. Generate the migration of the referenced module first (`make:migration create_rooms_table --module=rooms`,
then `make:migration create_bookings_table --module=bookings`), or rename the file of the later one so that its timestamp is the
larger, and check that its timestamp is the smaller one for the referenced table: two commands in the same second get the same
timestamp. On Postgres a file that runs too early stops with the database's error for a missing table. SQLite accepts the
reference and only checks it when rows are written, so check the order with `migrate:status` before you deploy. Rename a file only before it has run. The starter kit's migrations start
with `0001_01_01_` and come before any you write. A `.ts` or `.js` file in the folder whose name does not fit the pattern stops
every migration command with the name it expects, and so do two migrations with the same name and a module whose `migrations`
folder does not exist.

## Migration structure

A migration file exports `defineMigration({ up, down })`. `up` makes the change, and `down` undoes it. Both receive a `Schema` and
**build a plan** with it: each call adds a step and runs nothing. When the migration runs, `migrate` carries out the steps in the
order they were added, all inside the migration's transaction.

| Method | What it adds |
| --- | --- |
| `schema.create(table, build)` | Creates a table. `build` describes its columns and indexes. |
| `schema.alter(table, build)` | Changes a table: new columns, indexes, renamed and dropped columns. |
| `schema.drop(table)` | Drops a table. |
| `schema.dropIfExists(table)` | Drops a table if it is there. |
| `schema.rename(from, to)` | Renames a table. |
| `schema.data(run)` | A change of the data: `run(db, { driver })` is an `async` function, [see below](#changing-the-data). |
| `schema.raw(statement)` | A statement the schema methods do not cover, [see below](#raw-sql). |

`up` and `down` are plain functions: `up: (schema) => { … }`. They are not `async`, and do not `await` anything. A function that
returns a promise is a type error in `defineMigration`, and `migrate` refuses it with error D14 and the name of the file. The
`schema` is closed when the function returns: a call that comes later, from inside a `schema.data()` callback for one, throws
instead of adding a step that would not be part of the plan.

A plan is the same every time it is built. Do not let the time, the environment, a file, the database or a value from another file
decide which steps `up` adds, or what they say: a migration describes one change, and the app has to know what it changed
without running it. Put what depends on the data into a `schema.data()` step.

A migration without `down` cannot be rolled back. A rollback that reaches it stops there with an error that names it.

### Migrations from a package

A module's `migrations` folder belongs to your app, so it has to be in your repository where a review sees every change. It has to
lie, by its real path (after following symlinks), in your app or in its workspace, and no `node_modules` directory may be on the
way below that. Anything else is refused with error D20: by `migrate`, the schema projection and `db:types`, and by every query of
the running app (under `marmeon dev` there is also a warning at startup that the migrations are not watched, and every query still fails with D20).
This covers the folder, each file in it and every entry below it, so a symlink in a subfolder is checked like one at the top.
What is checked is the directory, the files and the entries with their symlinks, not the imports: a migration has to hold its content itself.
An update of a package could change a migration your database has already run, or add a `schema.data()` step, and nothing would
show in your history. A migration file that only re-exports one from a package defeats the purpose, so put the content into the
file. The same goes for a helper that a migration imports: it belongs to your app, and a symlink to one in `node_modules` or outside
the workspace is refused too.
`migrate` also names a migration whose file changed after it ran ([see below](#a-migration-that-changed-after-it-ran)), but it sees only the file, not what the file imports.

The workspace of an app is the directory of its lockfile when that declares one (`pnpm-workspace.yaml`, or `workspaces` in its
`package.json`). A package of your own monorepo is fine, with the lockfile in the root of the monorepo. Without a declaration, or with
the workspace of a tool Marmeon does not read (Deno, Rush, Nx, Lerna), only the app's own directory counts. A package manager that
keeps packages outside the repository (a cache, a global store, `link:` to another repository) puts them out of reach.
A package cache inside the app, such as `DENO_DIR` or Bun's cache directory, is not recognised: keep it outside the app.

Move the migrations into a module of your app **with the same file names** and point `migrations` at them: `migrate` knows what
has run by the file name, so files that are written again under new timestamps would be new migrations. If your module is named
differently from the package's, change the rows of the migrations table once:
`UPDATE migrations SET module = '<your module>' WHERE module = '<package module>'`.

To keep using the package's module without its migrations, take them out of the definition:

```ts
const { migrations, ...rest } = packageModule;
export default defineModule({ ...rest, name: 'permissions' });
```

`rest` is everything else the module brings (providers, routes, commands), so only the `migrations` folder is left behind.

A package of your own monorepo lives outside `node_modules` and is not affected. Only the part of the path below the app's root
is checked, so an app that is itself installed under a `node_modules` still runs.

### Changing the data

A step added with `schema.data()` runs between the steps around it. The usual shape is a column that is added with a default and then
filled with the real values for the rows that are already there:

```ts title="modules/notes/migrations/2026_10_05_090000_add_slug_to_notes_table.ts"
import { defineMigration, sql } from '@marmeon/database';

export default defineMigration({
  up: (schema) => {
    schema.alter('notes', (table) => table.string('slug').default(''));
    schema.data(async (db) => {
      await db.updateTable('notes').set({ slug: sql`'note-' || id` }).execute();
    });
  },
  down: (schema) => schema.alter('notes', (table) => table.dropColumn('slug')),
});
```

A NOT NULL column with a default is added the same way on SQLite and Postgres. On Postgres a column can instead be added nullable and
made NOT NULL after the backfill, so it keeps no default:

```ts
schema.alter('notes', (table) => table.string('slug').nullable());
schema.data(async (db) => {
  await db.updateTable('notes').set({ slug: sql`'note-' || id` }).execute();
});
schema.alter('notes', (table) => table.notNull('slug'));
```

`table.notNull('slug')` makes an existing column NOT NULL, `table.nullable('slug')` lets it hold NULL again. A row that still has NULL in the
column stops the migration with the database's error, and the migration is rolled back. SQLite changes no column in place, so `migrate`
refuses a plan with either call on SQLite before running any step, with error D18; use the form with the default there.

`db` is a Kysely connection inside the migration's transaction, so a step that throws rolls back the schema steps before it too.
Its tables are typed loosely, because a migration runs against the schema of its own time, not the one `bootstrap/database.d.ts`
describes today. The second argument tells the driver, `'sqlite'` or `'pgsql'`, for the rare statement that differs.

A data step changes data only. A schema change in it, through the query builder (`db.schema.createTable(…)`) or as raw SQL that
begins with `create`, `alter`, `drop` or `do`, stops with error D4: add it as a step of its own with `schema.create()`,
`schema.alter()` or `schema.raw()`. So does a write to the migrator's own tables through the query builder.

This is a guard against mistakes, not a sandbox. Raw SQL that writes to the migrator's tables, and a connection taken from `db` without its plugins or a query compiled by hand,
are not looked into. Keep to the query
builder in a data step.

### Raw SQL

`schema.raw()` adds a statement for what the blueprint cannot express, such as an index with a `where` clause or an extension:

```ts
schema.raw(sql`create index notes_published_index on notes (published_at) where published_at is not null`);
schema.raw({ sqlite: sql`…`, pgsql: sql`…` }); // one statement per driver; a driver without one skips the step
```

A statement that names one of the migrator's tables stops with error D4 when the plan is built; that is a check of its words, not a
parse. Otherwise Marmeon does not look into the statement, but it looks at the result: a statement that renames or drops a table or
column the migrations know rolls the migration back with error D3 ([what `migrate` checks](#what-migrate-checks-after-each-migration)). A table, view, column or index it creates has no owner, no secret mark
and no timestamp or soft-delete marker, and Marmeon's picture of the schema (below) does not contain it: `selectAll()` of a table it
adds a column to leaves that column out (name it in the query), and `selectAll()` of a table it creates stays `select *`. Use the blueprint, with
`schema.create()`, `schema.alter()` and `schema.rename()`, for everything it can do: only what it describes is known. Changing a table or
column that raw SQL made with `schema.alter()` or `schema.rename()` stops with error D19, because Marmeon would not know the change.

### What the migrations describe

`Migrator.projection()` computes the schema the migrations describe from their plans alone, without a database and without running
anything: every table with its columns in order, their types, nullability, defaults and secret marks, its unique column sets, indexes
and foreign keys (with `onDelete` and `inverse`), its `timestamps()` and `softDeletes()` marks and the module that created it. It
replays the migrations in the order of their names, and applies the steps of each as `migrate` runs them: in an `alter`, dropped indexes first, then renamed columns, new columns, `notNull()`
and `nullable()` changes (by the column's name after the renames), new indexes, retired columns and last the dropped columns. A retired column stays in it, marked, and is left out of everything Marmeon derives from it except the secret marks. `schema.raw()` and
`schema.data()` steps change nothing in it. `migrate` computes it before it runs the first pending migration, so a plan it cannot hold stops the run
at once. Error D19 stops a table name that two migrations create without a `drop` between them, a column added twice, and a change of a table or column
no migration created with the blueprint (`alter`, `rename`, `renameColumn()`, `notNull()`, `nullable()`, or an index on it); dropping such a table is allowed.

Tables that nothing in the migrations creates, such as a table another tool made in the same database or one that raw SQL made, are not
in it, and neither are their columns. Create a table with `schema.create()` when Marmeon is to know it.

The projection is kept in `.marmeon/schema.json` (not committed, like the other files in `.marmeon/`), so a process does not import every
migration to learn it. `marmeon build` always computes it from the migrations and writes it over the file. Anything else that asks the
migrator for it reads the file only while it fits: it records the SHA-256 of every migration file and the version of `@marmeon/database`,
and is used only when all of them are the ones now present; otherwise the projection is computed again and written back where the
directory allows. The hash covers the migration file itself, not what it imports: a migration is self-contained and its plan the same on
every run (no time, no environment), so the file is all that can change it. [Deploying](deployment.md#building-and-starting) has the details.

The app's connections use the projection as their schema: its secret columns, soft deletes, timestamps and relations are the ones
the query builder works with, and it needs no query on the database for them. A process that serves requests loads it the same way
(the file while it fits, otherwise computed, kept in memory when the directory cannot be written), and the migrator that runs in
a process hands its own to that process's connections. [How the migrator keeps track](#how-the-migrator-keeps-track) says what
the app checks against the database. A table the projection does not know, such as one raw SQL or another tool made, passes through
the query builder as it is: no secret column, soft delete or timestamp mark applies to it.

## How the app knows its schema

The migrations are the one source, and the database holds none of what they say. The app computes a
[projection](#what-the-migrations-describe) from the migration files and keeps it in `.marmeon/schema.json`, a cache that `marmeon build`
writes fresh. [Table types](queries.md#table-types) shows the same schema as the committed `bootstrap/database.d.ts`, the one place that
lists the current definition of every table. The database holds only `migrations` and, on SQLite, `migration_lock`; the framework's
own tables (`jobs`, `sessions`, …) are ordinary tables that your migrations create. [How the migrator keeps track](#how-the-migrator-keeps-track)
has the states the app can find the database in, [what `migrate` checks](#what-migrate-checks-after-each-migration) the checks around
each migration, and [deploying new migrations](#deploying-new-migrations) what a release with new migrations does to a running app.
A table the projection does not know passes through the query builder unguarded, see [what the migrations describe](#what-the-migrations-describe).

## Running migrations

| Command | What it does |
| --- | --- |
| `marmeon migrate` | Runs every pending migration, in one new batch. |
| `marmeon migrate:status [--json]` | Lists every migration, with its batch or `Pending`. See [status](#status). |
| `marmeon migrate:rollback` | Undoes the last batch. `--step=3` undoes the last three migrations instead, whatever their batch. |
| `marmeon migrate:reset` | Undoes every migration. |
| `marmeon migrate:fresh` | Drops every table and runs every migration again. `--seed` runs the [seeders](seeding.md) afterwards. |

**Each migration runs in a transaction of its own.** SQLite and Postgres both roll back a schema change, so a migration that fails
leaves no half-changed table behind, and it is not recorded. The migrations before it in the same run stay done.

`migrate` and `migrate:fresh` write the table types afterwards when migrations ran, with `NODE_ENV=development` only. `--no-types`
skips that. `migrate:rollback` and `migrate:reset` do not write them: after a rollback, run `marmeon db:types` to bring the file
back in line. With `NODE_ENV=development`, `migrate` and `migrate:fresh` stop before any step (before `migrate:fresh` drops a table) when `bootstrap/database.d.ts` comes from a newer Marmeon, because they would have to write over it; `--no-types` skips this check. The [repositories and queries](queries.md#table-types) page explains the file.

`migrate`, `migrate:rollback`, `migrate:reset` and `migrate:fresh` take `--wait=<seconds>` (default 60): how long to wait for another migration to end, see [one migration at a time](#one-migration-at-a-time).

A rollback needs the file of every migration it undoes. One whose file is gone stops it with an error that names the migration.

### One migration at a time

Two containers that start together and both run `marmeon migrate` do not run into each other: the second waits until the first has
finished, finds nothing left to do and exits. `migrate`, `migrate:rollback`, `migrate:reset` and `migrate:fresh` all take the
lock (`migrate:fresh` before it drops anything), `migrate:status` does not.

- **Postgres** holds an advisory lock in a transaction that stays open for the whole run, on a connection of its own, opened from
  the connection's URL and not taken from the app's pool (so `DB_POOL_MAX=1` works). The lock ends with the connection, so a
  process that crashed lets go of it by itself. If that connection ends while a migration runs, the run stops before the next
  migration with exit code 1. A migration checks the lock inside its own transaction, just before it writes its record; between
  that check and the commit a few milliseconds remain in which a lost lock goes unnoticed, and a waiting migration could read
  the list of migrations before the record is committed.
- **SQLite** keeps one row in the table `migration_lock`, with the time of the last sign of life, which every migration
  renews. A row whose process ran on the same host and is gone (a `Ctrl+C`) is taken over at once; any other row nobody has renewed
  for ten minutes belongs to a process that died, and is taken over too, with a warning. A migration that finds its row taken over
  stops before the next one. The table stays after a run, and `migrate:fresh` leaves it alone. Keep it out of your own table lists
  and dumps, like the `migrations` table.

A connection pooler in transaction mode (pgbouncer, the pooled URLs of Supabase or Neon) works too, because the open transaction
keeps the server connection. A server setting `idle_in_transaction_session_timeout` shorter than your longest migration ends that
transaction: the lock is lost, and the run stops before the next migration. Raise it for the role that migrates.

A command that cannot take the lock within `--wait` seconds (`--wait=0`: tries once) stops with exit code 1 and says who holds it:
`[marmeon:D8] Another migration has run since 2026-10-01T12:00:00.000Z (web-1:4242)`, the holder being `hostname:pid`. That wait is the lock's,
not a migration's: raise `--wait` when one of yours takes longer than a minute. `MigrationLockTimeoutError` and
`MigrationLockLostError` are what the commands report.

### How the migrator keeps track

The database holds two tables for the migrator, and nothing else of what the migrations say:

| Table | Holds |
| --- | --- |
| `migrations` | The migrations that ran, with their batch and the checksum of their file: `id`, `name`, `module`, `batch`, `checksum`. On the `default` connection only. |
| `migration_lock` | SQLite only: the row that [lets one migration run at a time](#one-migration-at-a-time). |

The first `migrate` on a database creates `migrations`. The columns `batch, checksum, id, module, name` are its format: a table with any other
columns (but see below for the form of 0.3) was written by a newer Marmeon (or is another tool's), and every command refuses it rather than guess what the columns mean. The
same holds for the columns of `migration_lock`. A migration that creates, alters, drops or renames `migrations` or `migration_lock`
stops with a `SchemaError` (D4) before anything runs, and so does a `schema.data()` step writing to them. Every other name is the app's,
the framework's own tables (`jobs`, `cache`, `sessions`, …) included. A connection with `managed: false` has neither table, and
the migration commands leave it alone.

**The running app reads nothing but `migrations`.** Which columns are secret, which tables have soft deletes and timestamps, and
the relations come from the [projection of the migrations](#what-the-migrations-describe): a process that serves requests computes it
from the migration files (or reads `.marmeon/schema.json`), and the migrator that runs in a process hands its projection to that
process's connections directly. The database is asked one thing, once, when the first query of a process needs the schema: which
migrations ran.

What the app does with the answer, per connection (`default` decides; the other connections take its state):

| State | When | What happens |
| --- | --- | --- |
| ready | The database has every migration the code has. | Queries run. |
| ahead | The database also has migrations the code does not know: a process of an older release during a deploy. | Queries run, with the schema the code knows: its secret columns, soft deletes and relations. Logged once. See [migrating a running app](#migrating-a-running-app). |
| pending | The database lacks a migration the code has: the app started before `migrate`, or after a rollback. The record in the form Marmeon 0.3 wrote, without `checksum`, counts as lacking too (see below). | **Every** query fails with a `MigrationStateError` (D2) that names the missing migrations, `/up/ready` is red. The database is asked again at most once a second, so the app answers a second after `marmeon migrate` ran, with no restart. A process that was ready before a rollback keeps its schema until it restarts. |
| newer | `migrations` has other columns than this release reads: a newer Marmeon migrated the database. | Every query fails (D1); `migrate`, `migrate:rollback`, `migrate:reset`, `migrate:status` and `migrate:fresh` refuse as well and change nothing. Update `@marmeon/*`. |
| unmigrated | The database has tables and no `migrations`: a database that lost it, or another tool's. | Every query fails (D1). For your own database, run `marmeon migrate`: it writes `migrations` and runs every migration, and tables it did not make stay as they are, unknown (see below). For a database another tool manages, set [`managed: false`](database.md#a-database-another-tool-manages). |

It never works as if no column were secret and no row deleted: a code with migrations the database lacks is refused rather than
trusted to have columns that are not there. A connection set to `managed: false` is the exception: it reads the catalog and knows no
secret column, no soft delete and no timestamp. If it has a `migrations` table with the columns Marmeon writes, though, Marmeon
migrates the database after all, and its queries fail (D1) until the option is removed. A `migrations` table of another shape is another
tool's and is read like any other table.

`marmeon db:show` looks at the database as it is, whatever its state. The migrator reads `migrations` with a connection of its own,
so `migrate`, `migrate:status` and `migrate:rollback` work on a database the app refuses. A Postgres role is checked like any other: the
tables are listed from the catalog whatever the role may do with them, so a role without privileges on `migrations` gets "permission
denied" on its queries instead of an app that believes no migration is missing.

`checksum` is `sha256:<hex>` of the migration file as it was when it ran, with `\r\n` read as `\n`, so a checkout with converted line
endings gives the same value. It is a record of what ran, to find out later whether a file that ran has changed; whoever can write to
`migrations` can write a checksum as well, so it detects a change and does not authenticate one. A migration whose `checksum` is `NULL`
is unknown, never changed.

A database from Marmeon 0.3 has `migrations` without `checksum`. The next `migrate`, `migrate:rollback` or `migrate:reset` carries it
over, under the migration lock and in one transaction: it adds the column and writes the checksum of the file as it is now to every
migration that has one (a migration without a file stays `NULL`), and says so. That is the one time a file becomes the reference
without having been checked, and the checksum of a row is never filled in afterwards. A migration that a process of 0.3 runs after that is recorded without a checksum and stays unknown for good. Until then every query of the app fails (D2) as
with a migration that is missing, `/up/ready` is red, and `migrate:status` and `migrate:fresh` read the old form without writing.
A database from Marmeon 0.3 has three tables more, `table_owners`, `secret_columns` and `schema_markers`.
Nothing of this release reads or writes them, and `migrate` leaves them where they are, naming them once per run: a process of 0.3 that
is still running reads them, and 0.3 reads a table that is gone as "no column is secret". Drop them by hand once no process of 0.3 runs.
`migrate:fresh` drops them with everything else.

#### What `migrate` checks after each migration

The projection says which tables and columns the database has now. After every migration (and every `down()`), in its transaction,
`migrate` reads the catalog of the connection the migration ran on and compares:

- A table or column the projection puts on that connection and the database does not have **rolls the migration back** with error D3.
  This is what catches raw SQL that renames or drops a table or column (`` sql`alter table users rename column password_hash to pw` ``): the
  projection would go on to call `password_hash` secret and not know `pw`, which `select pw` would then return. Use `schema.alter()`
  (`renameColumn`, `dropColumn`) and `schema.rename()`, which the projection follows. The check cannot see a rename in raw SQL that
  is followed by a new column of the old name (`rename column password_hash to pw`, then `add column password_hash`): rename secret
  and soft-delete columns only with `schema.alter()` and `schema.rename()`. Raw SQL bypasses the protection.
- Before the first migration of a run, `migrate` makes the same comparison once for the migrations that already ran, so an old mismatch is
  not blamed on the first migration of the run, and refuses a run that would create a table the database has already (`already has the
  table users, which migration … creates — is this the database you mean?`). Nothing has run then, and no record is left behind: `migrations`
  is created in the transaction of the first migration.
- A table or column the database has **beyond** the projection is no error. Raw SQL may add a column, another tool a table, and a newer
  release of the app has migrations this one does not know. `migrate` names them once per connection after the run. `selectAll()` and
  `returningAll()` of a table write out the columns the migrations know, so a column Marmeon does not know is never read by accident, and a
  table Marmeon did not create has no secret columns, soft deletes or timestamps: create what the app reads with `schema.create()`, or
  type a table of another tool with `withTables<…>()` ([queries](queries.md)). Tables of an extension (PostGIS's `spatial_ref_sys`), SQLite's
  own and the leftovers of 0.3 are not named.

A migration is also refused, before any migration of the run has started, when the order it runs in gives another schema than the order
of the names. Every other process (the build, the types, the projection file, a second app server) replays the migrations by name, but
the database has them in the order they ran, the pending ones after. A migration with a timestamp older than one that already ran
(a branch merged late) that changes a table the later one changed would leave the two disagreeing; the message names it, and the way
out is to rename the pending file so its name sorts after the other. On a database where that file already ran, change its row in `migrations` to the new name too, or it runs again. Migrations that touch different tables run in either order and
are not affected.

[Error codes D1 to D4](errors.md#server-error-codes) name these cases.

### Migrating a running app

The app knows what the migrations marked, such as [soft deletes](#timestamps-and-soft-deletes) and
[secret columns](#secret-columns), from the [projection of the migration files](#what-the-migrations-describe), not from the
database. A running app and a migration meet in three places:

- **In the process that migrates** (`marmeon migrate`, a test), the migrator hands the schema it leaves to that process's connections as
  each migration commits. While a migration's transaction is open, the other connections keep the schema from before it and do not
  wait for it. The `schema.data()` steps of the migration see the schema as the plan has changed it up to them: a table the plan
  created, with its soft-delete mark, is known to the step that fills it, and to nobody else yet. A run that fails (`migrate`,
  `migrate:rollback` or `migrate:reset`) hands the schema back: the next query of that process compares the migration files with the
  database again, as in a process that starts, instead of trusting a run that did not finish.
- **In another process** that started before `marmeon migrate` ran, nothing changes while it runs: the process keeps the schema of its
  code, and a column the new migrations add is not in it (the state `ahead` in
  [how the migrator keeps track](#how-the-migrator-keeps-track)). A relation, and every `selectAll()` and `returningAll()` of a table
  the migrations created, name the columns the code knows (see [secret columns](#secret-columns)): a column a newer migration adds,
  secret or not, is not in the result of an old process, and a column that migration marks `.secret()` never leaves the database
  through one. A query that names the column itself, or raw SQL, still reads it.
- **In a process whose code is newer than the database**, such as an app that starts before `migrate --force` has finished, or after a
  rollback, every query is refused with a `MigrationStateError` (D2) that names the missing migrations, and `/up/ready` is red, so a load
  balancer sends no request there. The process looks at the database again at most once a second and answers as soon as the migrations
  have run. A process that was ready when a rollback ran keeps the schema it had until it restarts (the process that rolled back
  continues with the schema of the migrations that remain); one started afterwards with the newer code is pending until the next `migrate`.

A query of an old process that names a column a migration dropped fails at the database, as it would anywhere. So does every
`selectAll()`, `returningAll()`, relation and finder of that table, since they name the columns the old code knows, even when that code
no longer uses the column itself: the old process fails rather than answering with a different set of columns. See
[deploying new migrations](#deploying-new-migrations) for what to do.

Reading the whole row of a table as one value (`to_jsonb(users)`, `eb.table('users')` in a function) is refused for the same reason:
the row may hold a column this release does not know. Name the columns.

> [!WARNING]
> `migrate:fresh` drops **every** table of the database, also tables that no migration created, and every table of the other
> connections that migrations run on. Use it on a development database only.

### Deploying new migrations

A release with new migrations goes out in this order:

1. **Run `marmeon migrate --force` once**, in a one-off container or a release job, with the new release's code. Two that run at once
   are safe ([one migration at a time](#one-migration-at-a-time)).
2. **Then roll the processes.** An instance of the new release that starts before step 1 has finished is pending: it refuses every
   query and `/up/ready` is red until `migrate` has finished, and it answers within a second of it.

While the rollout runs, instances of the old release are *ahead*: the database has migrations their code does not know. They keep
their schema, select the columns they know and hide the secret ones they know, and a column or table the new migrations add is
invisible to them. That makes a migration safe for them when it only adds:

- **A new table or index, and a new column that is nullable or has a default, is safe** at any moment.
- **Dropping or renaming a column breaks the queries of the previous release.** Their `selectAll()`, `returningAll()`, relations and
  finders on that table name every column the previous release knows, so they fail for as long as the rollout lasts, even when that
  release no longer uses the column. Dropping or renaming a whole table breaks it the same way. There are three ways to deal with it:
  1. **Accept the risk, knowingly.** Drop or rename in the release that stops using the column. The old instances fail on that table
     until they are replaced; for a short rollout, or a table few requests touch, that can be the right price.
  2. **Retire the column in the release before, and drop it in the next.** `table.retire('column')` changes only what Marmeon knows:
     [see below](#retiring-a-column). The release that retires it stops reading and writing the column while the previous one still
     does, and the release after it drops it with `dropColumn()` when no instance that knows the column is left.
  3. **Stop the previous release's processes before `migrate`**, then run it and start the new release. Nothing old is running when
     the column goes; the price is the downtime between the two.

  A whole table needs no `retire()`: stop using it in one release and drop it in the next.
- **A new `NOT NULL` column** breaks the inserts of an old instance. Add it with a default, or nullable and make it `NOT NULL` with
  `notNull()` only in the release after (Postgres only; SQLite refuses `notNull()` with D18, so use the default there).
- **A new secret column** is hidden from old instances, since they select only the columns they know. A query of theirs that names the
  column, or raw SQL, still reads it.

### A migration that changed after it ran

A migration that ran never runs again, so editing its file changes nothing in the database. `migrate` compares the checksum of each
migration that ran with the one of its file now, and says so before it runs the first pending migration (also when none is pending):

```text
2026_01_05_000000_create_accounts_table (accounts) changed since it ran in batch 1.
```

`migrate:rollback` and `migrate:reset` do the same for the migrations they are about to roll back, because the `down()` that runs is the
one of the file as it is now. `migrate:status` prints the warning for every such migration and lists it in `warnings` of its [JSON](#status).
It is a warning only: nothing stops and the exit code stays 0. A migration without a recorded checksum is unknown and never warned of. A
change to a helper that the migration imports is not seen, since the checksum covers the file alone.

To undo it, put the file back as it was and write the change as a new migration. An app can ask for the same answer in code with
`Migrator.changed()`.

### Retiring a column

```ts title="modules/notes/migrations/2026_10_20_100000_retire_legacy_slug_of_notes_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) => schema.alter('notes', (table) => table.retire('legacy_slug')),
  down: () => {},
});
```

`retire()` runs no statement. The column stays in the database, and leaves what Marmeon knows of the table: `selectAll()` and
`returningAll()` no longer write it out, relations and finders no longer use it, and `marmeon db:types` leaves it out of
`bootstrap/database.d.ts`, so the code of the retiring release cannot name it. `migrate` does not report it as a column no migration
made, but the check after each migration still expects it in the database until `dropColumn()`, so do not drop it with raw SQL. The release that follows drops it with `table.dropColumn('legacy_slug')`, which runs the
`ALTER TABLE`.

- **A retired secret column stays secret** until it is dropped: a query that names it is still refused (error D9).
- **A retired column cannot be changed.** `renameColumn()`, `notNull()`, `nullable()` and an index on it stop with error D19; only
  `dropColumn()` works. Nor can a primary key, the column of `timestamps()` or `softDeletes()`, or a column another table's foreign
  key references be retired. A foreign key on a retired column and the relation it gave are no longer known; the constraint stays in
  the database until the column is dropped.
- **A fixed default in a unique index is refused.** A column with a `default(value)` or `useCurrent()` default that is in a unique
  index (its own `unique()` or a composite one) would get the same value from every insert of the new release, and the second insert
  would fail, or a composite index would silently make the other column unique. Error D19 asks for `table.dropUnique(name)` first, in
  the same `alter()` or an earlier one.
- **A foreign key cannot point at a retired column**: `constrained(table, column)` on one stops with error D19.
- **The column has to be nullable or have a default**, because the new release inserts without it and the database must accept
  that. A `NOT NULL` column without a default is refused with error D19 rather than left to fail on the first insert in production.
  On Postgres make it nullable in an earlier migration with `table.nullable('column')`; on SQLite, which cannot change a column,
  use the third way above.
- **Retire in the release before the drop, not in the same one.** Marmeon cannot tell which instances still run: the drop has to wait
  until every instance of the release before the retirement is gone.

For an app that ran on Marmeon 0.3, see [how the migrator keeps track](#how-the-migrator-keeps-track).

### While you develop

With `marmeon dev` the server watches the migrations directory of every module. A migration file you add, change or remove is read
again at once, with no restart: the schema of the app is computed from the files again and compared with the database. After you add
a file, every query is refused with the `MigrationStateError` (D2) that names it, until `marmeon migrate` has run in another terminal;
the app answers within a second of that. Removing a file the database has already run leaves the app running with the schema of the
files that remain. Roll a migration back with `marmeon migrate:rollback` (or start over with `marmeon migrate:fresh`) before you change it. If you
edit one that has already run, the app works with a schema that no longer matches the database, because at run time only the names of the migrations are compared with it, and
the check of the database against the migrations runs only in `migrate`. A migrations directory that is created while the server
runs is watched after the next restart. Nothing is watched with any other `NODE_ENV`: a production server reads the migration files once, when it starts.

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


### Status

`migrate:status --json` prints a [machine-readable document](console.md#machine-readable-output) with the migrations ordered by name, as the text table lists them:

```json
{
  "format": 1,
  "migrations": [
    { "name": "2026_01_01_000000_create_users_table", "module": "auth", "batch": 1, "status": "ran" },
    { "name": "2026_01_05_000000_create_accounts_table", "module": "accounts", "batch": null, "status": "pending" }
  ],
  "warnings": []
}
```

`module` is the name of the module the migration belongs to. `status` is `"ran"` or `"pending"`; `batch` is a number for a migration that ran and `null` for a pending one; `migrations` is `[]` when no module has any. `warnings` is always there: it names each migration the record says ran but no module has a file for (`<name> ran in batch <n> but no module has its file`), which the text output prints as a warning too, and each migration whose file [changed after it ran](#a-migration-that-changed-after-it-ran) (`<name> changed since it ran in batch <n>`). A record this
release cannot read (other columns, see [how the migrator keeps track](#how-the-migrator-keeps-track)) fails the command: stdout stays empty, the
message with its code is on stderr, the exit code is 1.

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
| `uuidId(name = 'id')` | `uuid`, primary key, [UUIDv7](#uuid-keys) default | `uuid`, primary key, UUIDv7 default | `string` |
| `foreignUuid(name)` | `uuid` | `uuid` | `string` |

Two shortcuts add common columns and mark the table. `timestamps()` adds `created_at` and `updated_at`, both set to the current
time on insert. `softDeletes()` adds a nullable `deleted_at`. What the marks change is under
[timestamps and soft deletes](#timestamps-and-soft-deletes). Defining the same column twice throws.

### Modifiers

A column is `NOT NULL` unless you say otherwise:

| Modifier | Effect |
| --- | --- |
| `.nullable()` | Allows `NULL`. The column's type gains `\| null`. |
| `.default(value)` | A default for inserts. The value must fit the column's type, and a JSON default is a value: `.default({})`. |
| `.useCurrent()` | On a timestamp: the time of the insert is the default. |
| `.useUuidv7()` | On a `uuid` column: the database generates a [UUIDv7](#uuid-keys) when an insert gives none. |
| `.unique()` | A unique index on this column, named `{table}_{column}_unique`. |
| `.primary()` | The primary key. |
| `.secret()` | A column that is never read by accident. See [secret columns](#secret-columns). |

A column with a default, or a generated id, is optional on insert: its type is `Generated<…>`. The compiler holds the modifiers to
their columns. A default that does not fit the column, `NULL` as the default of a column that is not nullable, and `useCurrent()`
on anything but a timestamp (and `useUuidv7()` on anything but a `uuid` column) are compile errors.

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

`constrained()` guesses the table from the column's name in the English plural, `note_id` → `notes`, `category_id` →
`categories`, `status_id` → `statuses`, and references its `id`. Name the table when the guess is wrong, as for an irregular word
(`person_id` → `constrained('people')`), and the column when it is not `id`: `constrained('accounts', 'uuid')`. Then `cascadeOnDelete()` deletes the row along with the referenced one, `nullOnDelete()`
sets the column to `NULL`, and `restrictOnDelete()` refuses to delete the referenced row while this one points at it. Without any
of them, the database's default applies and refuses the delete as well. The compiler only offers the three after
`constrained()`, and `.nullable()` goes last, as in `uploaded_by` above. Both SQLite and Postgres enforce the reference.

Every foreign key also describes two relations, one for each table. The
[relations from foreign keys](#relations-from-foreign-keys) section shows how they are named.

### Indexes

`table.index(columns)` adds an index and `table.unique(columns)` a unique index, over one column or a list. Their names are
`{table}_{columns}_index` and `{table}_{columns}_unique`, joined by underscores, unless you pass a name as the second argument.
Postgres cuts a name at 63 bytes without a word, so on Postgres a migration that would create an index with a longer default
name is refused. A table you made earlier may hold the cut name, so pass the name Postgres stored for it (`select indexname from
pg_indexes where tablename = '…'`) in a migration that exists already, and a name of your own in a new one; a later `dropIndex`
needs the name the database holds.

The unique index is what keeps a value unique when two requests insert at the same moment. A validation rule only gives the
friendly message before the insert. The [validation](validation.md#the-unique-index-is-the-truth) page shows both together.

### UUID keys

A UUIDv7 is a UUID that starts with the time in milliseconds, so new rows sort by creation, much like an integer key. The
database makes it, as the column's default: it holds however a row is inserted, by a repository, by Kysely or by raw SQL, and an
insert may give its own value instead. `uuidId()` and `useUuidv7()` are an option; `id()` stays the default and is a fine choice.
Which key a table gets is a decision of the app, and two patterns are on offer:

```ts title="modules/teams/migrations/2026_10_02_090000_create_team_tables.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) => {
    // Pattern 1: the UUID is the primary key, and foreign keys hold it.
    schema.create('teams', (table) => {
      table.uuidId();
      table.string('name');
    });
    schema.create('members', (table) => {
      table.uuidId();
      table.foreignUuid('team_id').constrained().cascadeOnDelete();
      table.string('name');
    });
    // Pattern 2: an integer primary key for relations and joins, a UUID for URLs, mails and APIs.
    schema.create('profiles', (table) => {
      table.id();
      table.uuid('public_id').unique().useUuidv7();
      table.string('name');
    });
  },
  down: (schema) => {
    schema.drop('members');
    schema.drop('teams');
    schema.drop('profiles');
  },
});
```

`uuidId(name = 'id')` is short for `uuid(name).primary().useUuidv7()`, and `foreignUuid(name)` is `foreignId()` for a UUID: it takes
`constrained()` and the on-delete rules. With the second pattern, a repository names the public key with
`static routeKey = 'public_id'`. The database generates the key on both drivers: SQLite from plain SQL (no function to register, so the
file stays usable with the `sqlite3` command line), Postgres from `gen_random_uuid()` and the clock, so Postgres 13 is enough.
`marmeon db:types` types such a column as `Generated<string>`.

What the two patterns trade:

| | UUID as primary key | Integer key and a public UUID |
| --- | --- | --- |
| Index size | 16 bytes per key on Postgres (a `bigint` is 8), 36 bytes of text on SQLite. Every foreign key and every index that holds the key grows with it. | The primary key and the foreign keys stay narrow. The public key costs one more column and one more unique index. |
| Writes | A version 7 key is ordered by time, so inserts land near each other, much like an integer. A random version 4 key scatters them. Rows made within the same millisecond have no order among themselves, so order a list by a timestamp when it matters. | Same for the public key's index. |
| Enumeration | Keys cannot be counted through like `/notes/42`, `/notes/43`; an unguessable key is no substitute for checking who may see the row. | The same, as long as URLs and APIs only show the public key. |
| What the key tells | The creation time, to the millisecond. | The same for the public key. Where that matters, generate a random one yourself: `crypto.randomUUID()` on insert. |
| Changing your mind | Hard once other tables hold the key. | On Postgres, `schema.alter()` adds a public key at any time and gives every existing row its own value. On SQLite a UUIDv7 column exists only when the table is created, and `schema.alter()` with `useUuidv7()` is refused. |

Pick what suits the table. Tables that other tables reference a lot favour the narrow key; tables whose rows are created in many
places at once, or merged from several databases, favour the UUID as key.

### Adding to an existing table

On Postgres, `schema.alter()` adds a UUIDv7 column to a table that has rows, and every existing row gets its own value:

```ts title="modules/profiles/migrations/2026_10_03_090000_add_public_id_to_profiles_table.ts"
schema.alter('profiles', (table) => {
  table.uuid('public_id').unique().useUuidv7();
});
```

On SQLite, a UUIDv7 column exists only when the table is created. SQLite adds no column whose default is computed, so a plan with
`schema.alter()` and `useUuidv7()` is refused before its first step runs, and nothing of the migration changes. To give such a table a public key on SQLite, create the
table with the column in the first place, which is easiest before the first deploy, or create a new table with the column,
copy the rows and drop the old one. Marmeon refuses `alter` on SQLite whether or not the table has rows, so a migration that
works in development works on every deploy.

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
| `table.notNull(column)` | Makes an existing column NOT NULL. Postgres only, error D18 on SQLite. |
| `table.nullable(column)` | Lets an existing column hold NULL. Postgres only, error D18 on SQLite. |
| `table.retire(column)` | Takes a column out of use, one release before it is dropped. Changes no statement; see [retiring a column](#retiring-a-column). |

These seven work in `alter()` only, and `create()` throws when it finds them. Each change runs as a statement of its own, because
SQLite changes a table one step at a time. The order is fixed, whatever order you write them in: dropped indexes first, then
renamed columns, new columns, NOT NULL and nullable changes, new indexes, retired columns, and dropped columns last. A column in `notNull()` or `nullable()` is named as it is after a `renameColumn`. So dropping a column and adding one of the same name needs
two `alter()` calls. Two rules come from SQLite as well: a new `NOT NULL` column needs a default, and a column with an index
cannot be dropped before its index.

### Renaming a table

A migration that renames a table keeps the names of its indexes and constraints in step with it by passing `indexes`:

```ts
schema.rename('invoices', 'bills', { indexes: true });
```

Every index and constraint whose name begins with `invoices_` is renamed to begin with `bills_`, and on Postgres the
sequences of its identity columns too. A new name over 63 bytes is refused on Postgres, which would cut it: rename that index
yourself first, to a name of your choice. Without the option, `rename` changes the table's name only.

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
- the connection leaves it out of every `selectAll()` and `returningAll()`, also inside a subquery or a common table expression;
- those two name the columns the migrations know, for every table they created, not only for tables with a secret column: the
  connection sends `select "users"."id", "users"."name", … from "users"` instead of `select *`. A column the database has and the
  migrations do not describe, such as one a migration of a newer release added while an older process still runs, or one raw SQL or
  another tool added, is not selected, so it can never be a secret column that went unnoticed. Name it in the query to read it. A
  table no migration created (one raw SQL or another tool made) keeps `select *`, and so does every table of a connection with
  `managed: false`;
- a query reads it only with `secret(eb, 'password')`, in the one place that needs it. A query that names it otherwise, or reads the
  table's whole row as one value (`eb.table('users')` in a function), is refused before it is sent;
- a subquery or a common table expression that reads it with `secret()` passes it on as a secret column: the query around it asks
  with `secret()` again. That holds through a union, which lines its parts up by position, and a common table expression that
  refers to itself (with or without `RECURSIVE`), whose every column then counts as secret — the expressions of one `with` clause
  are checked as a whole, whatever their order, and one named like a table or like an expression around it is refused (rename
  it: which of the two a reference means differs between databases). A [relation](queries.md#relations-and-secret-columns)
  never loads one;
- names count without regard to case, as SQLite reads them: `TOKEN` is the secret column `token`. Two names of a query that
  differ only in case — an alias `K` inside a query on `k`, a common table expression `USERS` — are refused, since Postgres tells
  them apart;
- the value of a `set()` (an update's, an upsert's `doUpdateSet`, a merge's) and the values of an insert are read like a selection,
  so `set((eb) => ({ name: eb.ref('password') }))` is refused: the copy would sit in a readable column. A value may carry a secret
  when a secret column receives it, even one read from another table. `excluded` in an upsert is the row that was to be inserted and
  carries the table's secret columns, so `doUpdateSet({ email: eb.ref('excluded.password') })` is refused too. Rows an insert copies from a
  select may carry a column read with `secret()` only into a secret column. Statements on a table with secret columns are marked
  for observability whatever the case of its name, since SQLite reads `Users` as `users`;
- a subquery that selects it in a `where()` is refused too, although its value stays in the database. Filter on a key instead:
  `where('id', 'in', (eb) => eb.selectFrom('accounts').select('id').where(…))`;
- a statement of a kind the check does not know is refused, never let through unchecked, and so is a function whose name is not a
  plain identifier (`fn('…')` and `fn.agg('…')` send the name as written): a quoted name (`fn('"MyFunc"')`) is refused, a
  schema-qualified one (`pg_catalog.lower`) still works.

The starter kit's `UserRepository` is that place. It checks a password at sign-in, and the hash travels next to the user, never
inside it:

```ts
const row = await this.query().where('email', '=', email).selectAll().select((eb) => secret(eb, 'password')).executeTakeFirst();
```

`secret` comes from `@marmeon/database`. Raw SQL is not checked, so `` sql`select * from users` `` returns the hash, and so does a
view over the table, which is raw SQL of a migration. Statements on
a table with secret columns are marked as such for whatever records queries, which then leaves their parameters out. The
[observability](observability.md#queries-and-secret-columns) page explains it.

## Timestamps and soft deletes

`timestamps()` and `softDeletes()` do more than add columns. The migrator records them as marks of the table, next to the
secret columns, and the connection reads them:

- **`timestamps()`**: a repository's `update()` sets `updated_at` to the current time, unless the values set it themselves.
- **`softDeletes()`**: a repository's `delete()` sets `deleted_at` instead of deleting the row, and its `query()`, `find()`,
  `count()`, route binding and the rest leave deleted rows out, and so does every [relation](queries.md#soft-deleted-rows).
  `query().withTrashed()` and `forceDelete()` reach them on purpose.

A column of the same name without the call is an ordinary column: a `deleted_at` added with `table.timestamp('deleted_at')` deletes
nothing softly. The mark follows the table when it is renamed. It goes away when its column is dropped or renamed, and a
`softDeletes()` in the migration's `down()` brings it back. The [repositories](queries.md#repositories) page shows the methods.

## Relations from foreign keys

Each foreign key describes how two tables relate, so the relations are derived from the migrations, like the table types:

- **belongsTo**: the table with the foreign key gets a relation named after the column without `_id`. `comments.post_id` gives
  `comments.post`.
- **hasMany**: the referenced table gets one named after the table with the foreign key, `posts.comments`.
- **hasOne**: instead of hasMany, when the foreign key column alone is unique or the primary key. A table that holds one row per
  user, `table.foreignId('user_id').primary()`, gives `users.login_activity`.
- **belongsToMany**: a table with exactly two foreign keys to two other tables, unique together, links them both ways. Each side
  is named after the other table: `posts.tags` and `tags.posts` through `post_tag`.

```ts title="modules/blog/migrations/2026_10_08_090000_create_post_tag_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('post_tag', (table) => {
      table.foreignId('post_id').constrained().cascadeOnDelete();
      table.foreignId('tag_id').constrained().cascadeOnDelete();
      table.unique(['post_id', 'tag_id']);
    }),
  down: (schema) => schema.drop('post_tag'),
});
```

A one-relation, a belongsTo or a hasOne, may find no row. A hasOne always may. A belongsTo finds a row only when its foreign key is
`NOT NULL` and the referenced table has no soft deletes: a soft-deleted row never comes back through a relation.

### Naming the way back

Two foreign keys to the same table would give that table two relations of one name. So when a table has two or more foreign
keys to one table, each of them names its way back with `.inverse()`, after `constrained()` and before `.nullable()`. Naming only
some of them is not enough:

```ts title="modules/blog/migrations/2026_10_08_080000_create_posts_table.ts"
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('posts', (table) => {
      table.id();
      table.foreignId('author_id').constrained('users').cascadeOnDelete().inverse('authored_posts');
      table.foreignId('editor_id').constrained('users').nullOnDelete().inverse('edited_posts').nullable();
      table.string('title');
      table.timestamps();
    }),
  down: (schema) => schema.drop('posts'),
});
```

Now `posts` has `author` and `editor`, and `users` has `authored_posts` and `edited_posts`. Without both names, `db:types`
stops and says what to do, and the running app gives `users` neither relation:

```text
posts has two foreign keys to users (author_id, editor_id) — name the inverse relations: .inverse('…')
```

A foreign key to its own table follows the same rules: `categories.parent_id` gives `categories.parent` and the children as
`categories.categories`. `.inverse('children')` gives them a better name. A relation never hides a column either: a foreign key
named `owner` would give a relation `owner`, so `db:types` asks for `owner_id` instead.

`db:types` writes the relations into `bootstrap/database.d.ts` next to the tables, as `Relations`, with the keys each one
joins on. The connection derives the same relations at runtime, from the same migrations.

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
  fails is not recorded. The lock is checked before the first transaction commits, but not atomically with it: if the lock is
  lost right after that, the migration is applied on its connection and not recorded on `default`, and the next run starts it again.
- **Its table's books stay with the table.** Which module owns it, which columns are secret and its marks are kept on the
  connection the table is on, so a `selectAll()` there leaves the secret columns out too.
- `migrate:fresh` drops the tables of every connection a migration runs on.
- `db:types` reads the plan of every migration, so `Tables` knows every table, wherever it lives.

A connection that is not configured stops the migration with the names of the known ones.

## The framework's tables

Some drivers need a table: the database cache, sessions and queue, notifications and uploads. A command writes its migration into
your app, so the table is yours to change like any other:

```sh
pnpm marmeon make:cache-table
pnpm marmeon migrate
```

| Command | Or | Tables |
| --- | --- | --- |
| `make:cache-table` | `publish @marmeon/cache` | `cache`, `cache_locks`, on the cache's connection |
| `make:session-table` | `publish @marmeon/session` | `sessions`, on the sessions' connection |
| `make:queue-table` | `publish @marmeon/queue` | `jobs`, `failed_jobs`, on the queue's connection |
| `make:notifications-table` | `publish @marmeon/notifications` | `notifications`, on the notifications' connection |
| `make:uploads-table` | `publish @marmeon/storage` | `temporary_uploads`, on the uploads' connection |
| `make:sign-ins-table` | `publish @marmeon/auth` | `sign_ins`, on the default connection |

Both ways do the same: a `make:*-table` command is [`publish`](#publishing-the-migrations-of-a-package) for its own package. It
writes every migration of the package that your app lacks, with the rules of `publish` (a name that another package ships, a gap
and the choice of the module), and ends with exit code 0 and "Nothing to publish" when they are all there. The package need not be
in the `dependencies` of your app: the command comes from it. `marmeon publish <package>` also works for every package that
[declares its migrations](package-development.md#declaring-the-migrations-a-package-ships).

Each writes into the `system` module, or the module that `--module` names. The command creates the `system` module and adds it
to `bootstrap/app.ts` when it does not exist yet; it adds `migrations` to an existing module that lacks it. A `make:*-table`
command always opens an existing `system`, whichever way the app installs the package: its own command is running, so the package
is not one the app did not ask for. (`publish <package>` is stricter, see below.) When `bootstrap/app.ts`
or the module's `index.ts` has another shape (a list kept in a variable, say), it leaves the file as it is and says what to add. A migration that any module already has
under the same name is not written again. Each migration
reads its connection from the configuration when it runs: `CACHE_CONNECTION`, `SESSION_CONNECTION`, `QUEUE_DATABASE_CONNECTION`,
`NOTIFICATIONS_CONNECTION` and `UPLOADS_CONNECTION`. So its tables land on the
[connection](database.md#infrastructure-connections) the driver reads and writes.

The queue's migration creates `failed_jobs` next to `jobs`. With `QUEUE_FAILED_CONNECTION` set to another connection, it stops
with a message instead of creating the table where nothing looks. Split it then: the written migration keeps `jobs` with
`connection: '<the jobs' connection>'` in place of `queueTablesConnection`, and a migration of its own creates `failed_jobs` with
the other `connection`, as in [migrations on another connection](#migrations-on-another-connection).

`/up/ready` is red while a table of a driver you use lacks a column the code needs, and says which table and which command to run.
After an update of the packages, run `marmeon publish` at a terminal, or the table's `make:*-table` command: the framework's migrations are append-only, so a change of one of these tables arrives as a new file, never as a changed one.

### Publishing the migrations of a package

```sh
pnpm marmeon publish
pnpm marmeon migrate
```

`marmeon publish` lists the installed direct dependencies that declare migrations and, at a terminal, asks which of those that lack some to publish (numbers
separated by commas, `a` for all, empty for none). Without a terminal (no TTY, `CI` set, or `--no-interaction`) it asks nothing: it
prints the list and ends with exit code 1 when something is missing, with the hint to run `marmeon publish <package>` for each;
when nothing is missing it says "Nothing to publish" and ends with 0. The list holds the installed direct dependencies that declare
migrations, with what each lacks: `@acme/permissions — lacks 1: add_grants_table`, `— not published (2)`, `— complete`, or
`— refused` with the reason on the next line.

`marmeon publish <package> [--module=<name>]` copies the migrations of one package without asking. The package must be in the
`dependencies` or `devDependencies` of your app's `package.json` and installed in its `node_modules`: a package that only
another package brought is not copied; the package is looked for in the `node_modules` of the app and, in a workspace, of the
directories above it up to the first one with a lockfile. The module is `--module`; else the module whose `index.ts` carries the line `publish` writes when it creates a module for the
package; else the one the package proposes. With such a module, every file of the package that your app has must lie in it:
a file in another module stops the command with exit code 1, also when nothing is missing, because it is either a module you
moved the files to or a package that ships a name your app already uses. Without one, a file of the package in another module
stops the command the same way, unless all files are there and nothing is left to write. A proposed module that does not exist
is created and added to `bootstrap/app.ts` like the one of a `make:*-table` command. One that exists is opened without
`--module` only if it is `system` and the package is one of `@marmeon/…` that your `package.json` lists with a version range,
a dist-tag or `catalog:` (not an alias, a path, a workspace or a repository); in an app that installs the framework by
`workspace:` or `file:`, pass `--module=system`. The `make:*-table` commands are not held to that list. The tables of a package never land in one of your
modules unasked. `--module` is a kebab-case name, never a path, and needs a package.

A migration is known by its name without the timestamp, across the whole app. `publish` refuses, and writes nothing:

- **A name two packages ship.** When two installed direct dependencies ship the same name, both are refused: two migrations
  would create the same table. Only packages whose service provider your app has registered are seen: a package that declares
  migrations but is not registered (discovery turned off, say) ships nothing `publish` knows.
- **A gap.** When your app lacks a file of the package that sorts before one it has, the new file would run out of order. The
  message names both; copy the missing file from `node_modules/<package>` into that module by hand, with a timestamp before the
  one it follows (with an empty `up()` if your app does not want it).

Everything is planned before anything is written: `publish` writes nothing when it refuses, and one refusal for any chosen
package ends the command with exit code 1 and all the messages. If a write fails after the plan (a full disk, a directory
without permission), the command names the files it had written by then. A new file is put behind the newest migration of
your app, whatever its extension (`.ts`, `.js`, `.mts`, `.mjs`); a newest migration whose timestamp is no date, or that leaves no
room behind it, stops the command with exit code 1 and names the file.

The command writes what is missing and skips a migration your app already has under the same name (say, one that `make:auth`
wrote), so you can run it again: when nothing is left it ends with exit code 0 and says so. The files carry a timestamp one
second apart, in the order of their file names in the package, and behind the newest migration of your app, so a copy never runs
before one that has run. A package that adds a migration in a later release needs `marmeon publish <package>` again. It does not
touch the database; run `marmeon migrate` after it. To move the tables to another module later, move the files with the same
names and change their rows in `migrations.module`.

`marmeon publish --check` writes nothing and ends with exit code 1 when a package your app publishes from (see below) lacks
a migration, or when `publish` would refuse it. A package counts as published from when `publish` made a module for it, or when it
is a package of the framework with a migration in `system`; a migration of your own that has the name of a file of a package
does not make it one, so packages you have not published from are left out. A package taken into an existing module with
`--module` has no line of its own there, so `marmeon check` does not check it; run `marmeon publish --check <package>` for it. With a package
(`marmeon publish --check <package>`) it checks that package. [`marmeon check`](check.md#the-app-checks) runs the same test
as `package-migrations`. Put one of them in CI after you update the packages.

`publish` only copies files. It reads `static migrations` of the service providers your app boots, and imports the main entry of
each direct dependency a declaration points into (usually one the app has booted already; a declaration that cannot be read at all
makes it look at the entry of each direct dependency that lists providers in its `marmeon` field, to find the package that exports the provider). It reads the package's files
without following a symlink (a hard link to a file outside the package, which `realpath` does not reveal, is not detected). A
declaration that a package does not claim, because its provider is not exported from the package's main entry, or that cannot be
read and no direct dependency exports, is printed as a warning and changes nothing else. One that cannot be read and that a direct
dependency exports is that package's: `publish` refuses it, and the check fails when the app publishes from the package. Like every command of your app, `marmeon` boots your app first. Read the files of a package you do not know before you run `migrate`: they are code.

An app with a console command named `publish` of its own does not start (K8): rename it.
