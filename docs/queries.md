# Repositories & Queries

## Introduction

You read and write data with Kysely's query builder, typed by your app's tables. A **repository** is an optional class for one
table that keeps its queries in one place: rows go in, rows come out, and nothing happens that you did not call. There is no
lazy loading and no saving behind your back.

```ts title="modules/notes/NoteRepository.ts"
import { Repository } from '@marmeon/database';

export class NoteRepository extends Repository<'notes'> {
  static table = 'notes' as const;

  latestOf(userId: number) {
    return this.query().selectAll().where('user_id', '=', userId).orderBy('updated_at', 'desc').limit(10).execute();
  }
}
```

A controller asks for `NoteRepository` in its constructor and calls `latestOf()`, `find()` or `insert()`. Every name in a query
is checked against the table's type, and the result is typed by what the query selects.

## Table types

The types of your tables come from your **migrations**, never from the state of a database. `marmeon db:types` runs every
migration on a scratch database of the app's driver, SQLite in memory or a temporary Postgres database, reads the tables back and
writes `bootstrap/database.d.ts`. The file is committed, so a type check needs no database. On Postgres the command creates and
drops that temporary database, so its role needs the right to create databases.

`marmeon migrate` and `migrate:fresh` write the file for you when migrations ran, in development only. In production, staging and
tests the committed file is final, and the app's directory may not even be writable. `--no-types` skips it in development too.
In CI, `marmeon db:types --check` fails when a migration changed and the file was not written again:

```text
bootstrap/database.d.ts is out of date — run: marmeon db:types
```

The file fills the `Tables` interface, and `Relations` with the relations of the foreign keys. Views are not in it: `db:types`
reads tables only, on SQLite and Postgres. Three helpers turn a table into the row types you write code with:

```ts title="modules/notes/types.ts"
import type { NewRow, Row, RowUpdate } from '@marmeon/database';

export type Note = Row<'notes'>; // a row as read
export type NewNote = NewRow<'notes'>; // what an insert takes
export type NoteChanges = RowUpdate<'notes'>; // what an update takes
```

Some columns have types of their own:

| Type | Column | Read as | Written as |
| --- | --- | --- | --- |
| `Generated<T>` | An id, or a column with a default | always there | optional |
| `Timestamp` | `timestamp()` | an ISO-8601 string in UTC | a string or a `Date` |
| `Decimal` | `decimal()` | a string such as `'12.50'`, so no precision is lost | a string or a number |
| `JsonColumn` | `json()` | the parsed value | `JSON.stringify(value)` |
| `Secret<T>` | `.secret()` | left out of `Row<…>` | like any column |

A JSON column takes a string on purpose: Postgres would store an array that is not stringified as one of its own arrays.
`db:types` warns about a column type it cannot map, which is then typed as `unknown`, and about a table that no module's migration
created.

## Writing queries

`Database` is the default connection, typed by `Tables`. Inject it and use Kysely's builder:

```ts title="modules/notes/NoteSearch.ts"
import { Database, sql } from '@marmeon/database';

export class NoteSearch {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  search(userId: number, term: string) {
    const pattern = `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.#db
      .selectFrom('notes')
      .select(['id', 'title'])
      .where('user_id', '=', userId)
      .where(sql<boolean>`lower(title) like ${pattern} escape '\\'`)
      .orderBy('title')
      .orderBy('id')
      .execute();
  }
}
```

`sql` is Kysely's template, so your app needs no import of Kysely itself. A value in the template, such as `${pattern}`, is sent
as a parameter and never becomes part of the SQL text. `sql.raw()` is the exception: it puts a string into the SQL as it is, so
never give it input. `Kysely`, `Transaction`, `Selectable`, `Insertable` and `Updateable` are exported as types too.

Kysely's own documentation covers the builder: joins, subqueries, `onConflict`, `returning` and the rest. What Marmeon adds is
on this page.

> [!WARNING]
> Secret columns, such as the password hash, are left out of every `selectAll()` and `returningAll()` of the query builder, and
> a query reads one only with `secret()`. Raw SQL is not checked: `` sql`select * from users` `` returns the hash. The
> [migrations](migrations.md#secret-columns) page explains secret columns.

## Repositories

### Defining a repository

A repository extends `Repository<'table'>` and names its table again as a value, `static table = 'notes' as const`, because types
do not exist when the app runs. Without it, building the repository throws: `NoteRepository needs its table as a runtime value:
static table = '…' as const;`. Other statics change its behaviour:

| Static | Default | Effect |
| --- | --- | --- |
| `table` | required | The table, as a runtime value. |
| `connection` | `default` | Another connection. See [another connection](#another-connection). |
| `routeKey` | `id` | The column a route parameter is looked up in. |
| `routeKeyPattern` | digits for `id` | What a route parameter must look like before it is looked up. |

Timestamps and soft deletes follow the table's migration. When it calls `timestamps()`, `update()` sets
`updated_at`. When it calls `softDeletes()`, `delete()` sets `deleted_at`, and every read leaves deleted rows out. The
[migrations](migrations.md#timestamps-and-soft-deletes) page explains the marks.

A repository is an ordinary class, built by the [container](container.md#binding-services). It holds nothing but its connection,
so register it once in your module's provider: `container.singleton(NoteRepository)`. Its constructor takes `Connections` and
nothing else, which is what lets [`using(trx)`](transactions.md#transactions-you-control-yourself) rebuild it for another
transaction. Give other dependencies to the service that uses the repository.

### Reading

| Method | Returns |
| --- | --- |
| `query()` | A Kysely select on the table, to go on with `select()`, `where()` and the rest. Soft-deleted rows are left out. |
| `find(id)` | The row, or `undefined`. |
| `findOrFail(id)` | The row, or a 404 (`RecordNotFoundError`) that does not tell the client what was looked up. |
| `exists(id)` | Whether the row is there. |
| `count()` | How many rows there are. |
| `paginate(query, ctx.query)` | One page and the total. See [pagination](pagination.md#pages-by-number). |

`query().withTrashed()` keeps the soft-deleted rows, and so does a relation that calls it in its callback. The
[relations](#soft-deleted-rows) section shows both.

`this.query()` and `this.db` are there for your own methods. `this.db` is the whole connection, for statements on another table or
an `insertInto(…).onConflict(…)`.

### Writing

| Method | Returns |
| --- | --- |
| `insert(values)` | The row as stored, with its id and defaults. Secret columns are not in it. |
| `update(id, values)` | The row as stored, without its secret columns, or `undefined` when there is none. With timestamps, it sets `updated_at`. |
| `tryInsert(values)` | The row, or `undefined` when a unique index already holds the values. |
| `tryUpdate(id, values)` | The row, `undefined` when there is none, or `'duplicate'` when a unique index holds the new values. |
| `delete(id)` | Whether there was a row. With soft deletes, it sets `deleted_at`. |
| `forceDelete(id)` | Whether there was a row. It deletes for real, soft deletes or not. |
| `restore(id)` | Whether there was a row to bring back. It clears `deleted_at`. |

The values are exact: a field the table does not have is a compile error, also when the values come from a variable. With soft
deletes, `update()` leaves a deleted row alone.

`tryInsert()` and `tryUpdate()` decide "already taken" by the unique index, so two requests at the same moment cannot both pass.
They run in a transaction of their own, or in a savepoint inside an open one: on Postgres a failed statement breaks the
transaction around it, and the savepoint keeps that transaction usable. The starter kit registers a user this way:

```ts title="modules/auth/UserRepository.ts"
import type { PasswordHash } from '@marmeon/auth';
import { Repository } from '@marmeon/database';
import type { User } from './users.ts';

export class UserRepository extends Repository<'users'> {
  static table = 'users' as const;

  register(values: { name: string; email: string; password: PasswordHash; locale: string }): Promise<User | undefined> {
    return this.tryInsert(values);
  }
}
```

To answer a form with "taken" at its field instead, wrap the write in `failOnDuplicate()`. The
[validation](validation.md#the-unique-index-is-the-truth) page shows it.

### Route binding

Every repository can bind a route parameter: `notes.bind('note', NoteRepository)` gives the controller the row, or answers 404.
`routeKey`, `routeKeyPattern` and bindings scoped to a parent are on the [routing](routing.md#binding-a-repository) page.

## Relations

The foreign keys of your migrations relate your tables: `profile_links.user_id` gives `profile_links` a `user`, and `users` its
`profile_links`. The [migrations](migrations.md#relations-from-foreign-keys) page shows how the relations are named. `with()`
loads one into the same query, as JSON the database builds:

```ts title="modules/user-profile/ProfileDirectory.ts"
import { Database } from '@marmeon/database';

export class ProfileDirectory {
  readonly #db: Database<'user-profile'>;

  constructor(db: Database<'user-profile'>) {
    this.#db = db;
  }

  profile(id: number) {
    return this.#db
      .selectFrom('users')
      .selectAll('users')
      .with('login_activity', { as: 'activity' }, (activity) => activity.select('last_login_at'))
      .with('profile_links', { as: 'links' }, (links) => links.select(['id', 'user_id', 'label', 'url']).orderBy('id'))
      .where('users.id', '=', id)
      .executeTakeFirst();
  }
}
```

The result is the user's row with `activity: { last_login_at } | null` and `links: { id, user_id, label, url }[]`. It is **one
query**: there is no lazy loading, so there are no N+1 queries to fall into, and the [query log](observability.md) shows one
statement.

### Loading a relation

`with(name)` loads every column of the related table except its secret columns. A belongsTo or a hasOne gives one row or `null`,
a hasMany or a belongsToMany a list, empty when there is none. The names come from `bootstrap/database.d.ts`, so a wrong one is
a compile error that lists the right ones:

```text
Argument of type '"profile_link"' is not assignable to parameter of type '"login_activity" | "profile_links"'.
```

`with()` is a method of every select of the app's connection: a repository's `query()`, `Database`, a transaction, a subquery.
In a query that joins tables, it offers the relations of each table, except a name two of them share. Relations are offered on a
table's own name, `selectFrom('users')`, not on an alias such as `selectFrom('users as u')`. A module's
`Database<'user-profile'>` offers only relations to tables the module sees: its own, and the tables other modules expose.

> [!NOTE]
> Kysely has a `with()` of its own on the connection: `db.with('recent', (q) => …)` defines a common table expression. The
> relation method belongs to a select, `db.selectFrom('users').with('profile_links')`, so the two never meet.

### Narrowing and nesting

The callback gets the related table's query. Select, filter, order and limit it like any query, and load its relations with
`with()` again, to any depth. Its scope is the related table only: refer to the outer row through `sql` or `eb.ref()`, as in
`` links.where(sql<boolean>`profile_links.label <> users.name`) ``. When it selects columns of that table, the relation holds those
columns. When it selects none, because it only orders, filters or nests, the relation keeps every column but the secret ones.
`selectAll()` means the same:

```ts
this.#db
  .selectFrom('users')
  .select(['users.id', 'users.name'])
  .with('profile_links', (links) => links.where('label', '!=', '').orderBy('id').limit(3).with('user', (user) => user.select('name')));
```

`{ as }` gives a relation another key, `with('profile_links', { as: 'links' })`, with or without a callback after it.

A belongsTo is typed without `null` only when its foreign key is `NOT NULL` and the related table has no soft deletes. Otherwise
the related row may be missing, and the type says so. A hasOne may always be missing.

### Relations without a foreign key

`withRelation(name, definition, callback?)` loads rows no foreign key describes, or a relation in a shape of its own: the rows of
`table` whose `foreignKey` holds the outer row's `localKey`, which is `id` unless you name another column of the query's tables (the
first table that has it). With `one: true` it
loads the first row the callback's order gives, or `null`:

```ts
this.#db
  .selectFrom('users')
  .select(['users.id', 'users.name'])
  .withRelation('newest_link', { table: 'profile_links', foreignKey: 'user_id', one: true }, (links) => links.orderBy('id', 'desc'));
```

Its columns, secret columns and soft-deleted rows follow the rules of `with()`.

### Soft-deleted rows

A relation never loads the rows a table's [soft deletes](migrations.md#timestamps-and-soft-deletes) mark as deleted. Call
`withTrashed()` in its callback to keep them for that relation. On a repository's `query()`, `withTrashed()` keeps them in the
query's own rows:

```ts
// In a NoteRepository, when notes and their attachments both have soft deletes:
this.query().withTrashed().selectAll().with('attachments', (attachments) => attachments.withTrashed());
```

`withTrashed()` works on the level it is called on: the relations below it still leave deleted rows out unless their callbacks
call it too. On a plain `db.selectFrom()`, which filters nothing, it has nothing to keep. A table you join yourself, inside a callback or anywhere else, is your query: soft-deleted rows are not filtered
there.

### Relations and secret columns

A secret column never comes back through a relation. It is not among the columns `with()` loads, and naming one inside a relation
is refused when the query runs: by name, with `secret(eb, …)`, `sql.ref()` or `sql.id()`, under an alias, from a table the
callback joins, from the outer query or a subquery or common table expression of it, or deeper down. So is a whole row of a source
that holds one, such as `eb.table('users')` in a function.

That goes for a subquery in a relation's `where()` too, as in any query, although its value stays in the database. Filter on a key
instead: `where('user_id', 'in', (eb) => eb.selectFrom('personal_access_tokens').select('user_id').where(…))`, or with a join.

```text
with('personal_access_tokens') selects personal_access_tokens.token_hash, a secret column — a relation never loads one. Read it where it is needed, in a query of its own with secret(eb, …). See docs/queries.md#relations-and-secret-columns.
```

The text of a raw `` sql`…` `` template is not checked: a column written into it is the query's own choice. Neither is a view: it
is raw SQL of a migration, so a view over a table with secret columns returns what its own SQL selects.

### The app's connection

The app's connection resolves the relations from its database, where the migrations left the foreign keys and their marks. A
query built on a connection without Marmeon's plugins, `connections.infrastructure()` or Kysely's `withoutPlugins()`, is refused
before it is sent:

```text
This query loads relations or leaves out soft-deleted rows (with(), withRelation(), withTrashed(), a repository's query()), which only the app's connection resolves — it was not sent: it runs on the database connection "default" without Marmeon's plugins (infrastructure(), withoutPlugins()). Build it on connections.get() or Database. See docs/queries.md#relations.
```

Nested values come back with the same types as the outer row's: booleans, parsed JSON, decimals as strings and timestamps in UTC,
on SQLite and Postgres alike.

## Module boundaries

`Database` sees every table. `Database<'notes'>` is the connection as the `notes` module sees it:

- its **own tables**, created by its migrations, for everything;
- the tables other modules **expose**, for reading and joins only.

A module exposes a table in its definition. The starter kit's auth module exposes `users`:

```ts title="modules/auth/index.ts"
import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'auth',
  migrations: new URL('./migrations/', import.meta.url),
  exposes: ['users'],
  routes,
});
```

In the `notes` module, `insertInto('users')`, `updateTable('users')` and `deleteFrom('users')` are compile errors, and a table of
another module that is not exposed does not exist at all. Writing to `users` goes through the auth module's `UserRepository`. The
boundary is a type: at runtime both are the same connection, and raw SQL is not checked. A module that exposes a table another
module's migration created, or that no migration created, stops `db:types` with an error that says so.

The migrator records which module's migration created each table. That record is what the boundaries and the comments in
`bootstrap/database.d.ts` are built on.

## Errors

| Function | Says |
| --- | --- |
| `isUniqueViolation(error)` | Whether the error is a unique violation, on SQLite and Postgres. |
| `uniqueViolationColumns(error)` | The violated index's columns, as far as the driver names them. |
| `missingTable(error)` | The table a statement could not find, or `undefined`. |

Catch a unique violation inside a transaction only around a savepoint, as `tryInsert()` does. On Postgres the failed statement
otherwise aborts the whole transaction, and every later query in it fails.

## Another connection

A repository with `static connection = 'reporting'` works on that connection. Its tables still come from `Tables`, the types of
your migrations. Code that queries a connection with tables of its own asks `Connections` for it:
`connections.get<ReportingTables>('reporting')`. The [database](database.md#more-connections) page shows how to define one.

## Queries take turns

A physical connection runs one query at a time, in the order the queries were sent. Outside a transaction, a Postgres pool spreads
queries over its connections. A transaction holds one connection, and SQLite has only one, so there a `Promise.all` of queries,
such as the props of a page, runs one query after the other. A query stream (`.stream()`) holds its connection until it ends:
while it runs, send other queries to another connection.
