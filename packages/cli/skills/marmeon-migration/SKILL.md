---
name: marmeon-migration
description: Write a database migration in a Marmeon app — create a table, add or retire a column, change data — and keep the schema types current. Use it for any change to the database schema, including on SQLite where several changes of an existing table are refused, and before editing a migration file that may already have run.
metadata:
  marmeon-skill: "1"
---
<!-- Managed by marmeon agents:install — edits are replaced; copy the folder under another name to keep your own. -->

In this skill, `docs/<page>.md` means `node_modules/marmeon/docs/<page>.md`, the guide of the installed version.

# Write a migration

Migrations are the history of the schema, kept next to the module that owns the tables. The types in `bootstrap/database.d.ts`
are generated from them. Read `marmeon docs migrations` (`node_modules/marmeon/docs/migrations.md`) for anything below that is
not clear. If the marmeon MCP server is connected, its `schema` tool shows the tables the migrations describe now.

## Make the file

```sh
pnpm exec marmeon make:migration create_notes_table --module=notes
pnpm exec marmeon make:migration add_archived_at_to_notes_table --module=notes
```

- The name is snake_case. `create_…_table` writes a table with an id and timestamps; a name ending in `_to_…_table`,
  `_from_…_table` or `_in_…_table` starts an `alter()` of that table; any other name gives an empty migration.
- `--module` must name a module that exists. The file is named after the time it was made, always after the module's latest.
- Migrations run in the order of their file names across all modules. A foreign key to another module's table needs that table to
  be created earlier in time: generate the referenced module's migration first.

## Structure

A file exports `defineMigration({ up, down })`. Both are plain functions that receive a `schema` and add steps to a plan; they
are not `async`, and nothing inside them may depend on the time, the environment, a file or the database.

```ts
import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('notes', (table) => {
      table.id();
      table.foreignId('user_id').constrained().cascadeOnDelete();
      table.string('title', 200);
      table.timestamps();
    }),
  down: (schema) => schema.drop('notes'),
});
```

- Write `down` so it undoes `up`. A migration without `down` cannot be rolled back.
- `schema.alter(table, build)` changes a table; `schema.data(run)` changes rows; `schema.raw(statement)` is the last resort.
- A data step changes data only. A schema change inside it stops with error D4; make it a step of its own.
- Mark a column that holds a secret with `.secret()`. Raw SQL and tables made outside the migrations have no secret columns.

## A migration that ran is never edited

A migration that ran never runs again, so editing its file changes nothing in the database; `migrate` compares the checksum and
warns (`docs/migrations.md#a-migration-that-changed-after-it-ran`). Put the file back as it was and write the change as a new
migration. A comment or a blank line counts as a change too.

## SQLite refuses some changes of an existing table

SQLite cannot change a column in place, so `migrate` refuses these plans before any step runs, with error D18:

- `table.notNull()` and `table.nullable()` on an existing column. A new column that must be NOT NULL is added with a default and
  filled in a `schema.data()` step (`docs/migrations.md#changing-the-data`). An existing column keeps its constraint on SQLite: add a
  new column with the one you want and copy the values in a `schema.data()` step. Retire the old column only when it is nullable or
  has a default (`docs/migrations.md#retiring-a-column`); `retire()` refuses a `NOT NULL` column without a default with D19, so drop
  that one with `dropColumn()` in a release that stops the old processes before `migrate` (the third way in
  `docs/migrations.md#deploying-new-migrations`). Or keep the change to Postgres and say so.
- A column with a generated UUIDv7 default added by `alter()`. Create the table with it, or create a new table and copy the rows.
- `table.check()`, `table.dropCheck()`, `table.oneOf()` and `table.foreign()` on an existing table or column.

Write the migration so it works on the database the app runs on in production and on SQLite in development, or say that it
cannot. See `docs/migrations.md#changing-tables` and `marmeon docs errors` (D18). Two more rules come from SQLite: a new `NOT NULL` column
needs a default, and an index must be dropped before its column.

## Retire a column before you drop it

Dropping a column that the running release still reads breaks that release during a deploy. In one release call
`table.retire('column')`, which runs no statement and takes the column out of the types; in the next release drop it with
`table.dropColumn('column')`. Do not do both in one migration. The column must be nullable or have a default before it is retired.
See `docs/migrations.md#retiring-a-column`.

## Run it

1. `marmeon migrate` runs the pending migrations and, in development, writes `bootstrap/database.d.ts`.
2. `marmeon migrate:status` lists what ran and what is pending, and warns about a migration that changed after it ran.
3. `marmeon migrate:rollback` undoes the last batch; do that before you change a migration that ran only on your machine.
4. `marmeon db:types` rewrites the types alone, when the file is stale.

Outside development, `migrate` and the commands that destroy data refuse without `--force`. Never pass `--force` on your own
authority; ask the user.

## Seeders and factories

- `marmeon make:factory <Name> --module=<module>` writes a factory for one table; `marmeon make:seeder <Name> --module=<module>`
  writes a seeder; `marmeon db:seed` runs them. Read `marmeon docs seeding`.
- A seeder hashes a password with the app's configured costs; a factory stores one cheap hash (`docs/seeding.md#password-hashes`). Never put a real secret in either.

## Before you hand the change back

- The new table has its policy and its routes decided; see the `marmeon-feature-module` skill.
- The migration is the only place the schema is written: no table made by a tool outside the migrations.
- `marmeon check` is green, and the tests run against the migrated schema.
