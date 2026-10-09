# Seeding & Factories

## Introduction

A **factory** knows how to make a believable row of one table: every required column with a value. Tests use factories to create
the rows they need, and mail previews to build sample data. A **seeder** fills a database with the rows a developer wants to
find, such as an account to sign in with, and uses factories to make them.

```ts title="modules/auth/factories/UserFactory.ts"
import { defineFactory } from '@marmeon/database';

export const FACTORY_PASSWORD_HASH = '$argon2id$v=19$m=1024,t=1,p=1$4Xhubcoo37TNJTsjeD4YIg$tLK1IR1zuYLJNCVRYJaBxiXR+EuI6aAXP5Wt1Ha2xlQ';

export const UserFactory = defineFactory(
  'users',
  ({ sequence }) => ({
    name: `User ${sequence}`,
    email: `user${sequence}@example.com`,
    password: FACTORY_PASSWORD_HASH,
    email_verified_at: new Date().toISOString(),
    first_verified_at: new Date().toISOString(),
  }),
  { states: { unverified: { email_verified_at: null, first_verified_at: null } } },
);
```

`factory(UserFactory).count(3).create()` inserts three users and returns them as stored. This is the starter kit's factory, and
`marmeon migrate:fresh --seed` runs its seeder.

## Defining factories

`defineFactory(table, definition, { states })` takes the table, a function that returns one row's values, and named states. The
values are typed against the table's insert type. A new `NOT NULL` column without a default therefore makes every factory that
misses it a compile error, and you find them all at once.

The definition gets a context:

- **`sequence`** counts the rows this factory has made in this app: 1, 2, 3 and on. Use it for values that must be unique, such
  as an address. Each app counts on its own, so two test apps never share a counter.
- **`factory(Other)`** stands for a row of another table. Put it where a foreign key goes, and the related row is created first:

```ts title="modules/notes/factories/NoteFactory.ts"
import { defineFactory } from '@marmeon/database';
import { UserFactory } from '#modules/auth';

export const NoteFactory = defineFactory(
  'notes',
  ({ sequence, factory }) => ({
    user_id: factory(UserFactory),
    title: `Note ${sequence}`,
    slug: `note-${sequence}`,
    body: 'A note to read later.',
  }),
  { states: { shared: { shared: true }, published: () => ({ published_at: new Date().toISOString() }) } },
);
```

A state is a set of values that replaces the definition's, or a function of the context that returns them. A state as a function
gets a fresh value each time, such as the current time.

### Password hashes

Hashing a password is slow on purpose, and `count(50)` would hash fifty times. So the starter kit's factory stores one hash,
made once with the low costs of `.env.test`, and every factory user signs in with the password `password`. A seeder hashes with
the app's configured costs instead, as the next section shows. The [hashing](hashing.md) page explains the costs.

## Using factories

A factory is used through `factory(Definition)`, which a seeder gets in its context and a test from its app:

| Call | Effect |
| --- | --- |
| `.create(overrides?)` | Inserts one row and returns it as stored, with its id and defaults. Secret columns, such as `password`, are not in it. |
| `.make(overrides?)` | Returns the values without inserting anything. A related factory is not created either: its column keeps the factory itself, not an id. |
| `.count(n)` | `n` rows instead of one: `create()` and `make()` return a list. |
| `.state('shared')` | Applies a named state. Several states apply in the order you call them. |
| `.state({ title: 'Draft' })` | Applies values directly. |
| `.using(trx)` | Inserts through this connection or transaction. |

Overrides apply last, after the states:

```ts
const ada = await factory(UserFactory).create({ name: 'Ada Lovelace', email: 'ada@example.com' });
const notes = await factory(NoteFactory).count(3).state('shared').create({ user_id: ada.id });
```

Each call returns a new pending factory, so you can keep one and use it twice. A state the definition does not have throws, with
the states it knows. `create()` inserts the rows one after the other, each related row first.

## Writing seeders

A seeder is a class with a `handle()` method. The container builds it, so its constructor gets what it needs. `handle()` receives
`factory` and `db`, the default connection:

```ts title="modules/auth/seeders/UserSeeder.ts"
import { Hasher } from '@marmeon/auth';
import type { SeedContext } from '@marmeon/database';
import { UserFactory } from '../factories/UserFactory.ts';

export class UserSeeder {
  readonly #hasher: Hasher;

  constructor(hasher: Hasher) {
    this.#hasher = hasher;
  }

  async handle({ factory }: SeedContext) {
    await factory(UserFactory).create({ name: 'Test User', email: 'test@example.com', password: await this.#hasher.make('password') });
  }
}
```

A module lists its seeders in its definition, and they run in that order:

```ts title="modules/auth/index.ts"
import { defineModule } from '@marmeon/core';
import { UserSeeder } from './seeders/UserSeeder.ts';

export default defineModule({
  name: 'auth',
  migrations: new URL('./migrations/', import.meta.url),
  seeders: [UserSeeder],
});
```

## Running seeders

```sh
pnpm marmeon db:seed
pnpm marmeon db:seed --module=auth
pnpm marmeon db:seed --class=UserSeeder
pnpm marmeon migrate:fresh --seed
```

`db:seed` runs every seeder of every module, the modules in the order of `modules: [...]` in `bootstrap/app.ts`. `--module` runs
one module's seeders, and `--class` one seeder by its class name. An unknown module or class ends the command with an error that
names it. `migrate:fresh --seed` drops every table, migrates and then seeds: the way back to a known database in development.

Seeders do not run in a transaction. A seeder that fails stops the command, and the rows inserted before it stay. Run the seeders
on a fresh database, or write them so that running them twice does no harm.

Where the app is protected, in production, staging or without `NODE_ENV`, `db:seed` asks for `--force` like `migrate` does. The
[migrations](migrations.md#where-the-app-is-protected) page explains it.

> [!WARNING]
> Seeders are for development and test databases. The starter kit's seeder creates `test@example.com` with the password
> `password`, an account anyone can sign in with. Never pass `--force` to `db:seed` or `migrate:fresh --seed` against a database
> with real data: `--force` is all a protected app asks for, and `migrate:fresh` drops every table first.

## Testing

A test app has the same factories: `app.factory(UserFactory).create()`. With `seed: true`, `createTestApp()` also runs the seeders
for every test. The [database testing](database-testing.md) page explains both, and the [mail](mail.md#previews) page shows
`make()` building a preview's sample data.
