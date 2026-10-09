# @marmeon/database

The data layer of Marmeon apps on Kysely: connections, migrations per module, generated table types, repositories, factories,
transactions and pagination.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

SQLite is built in (`node:sqlite`, no native addon). Postgres needs the `pg` driver, an optional peer the app installs as a
dependency: `pnpm add pg@^8`. Without it, the first query fails and names that command.

## A first repository

```ts title="modules/notes/NoteRepository.ts"
import { Repository } from '@marmeon/database';

export class NoteRepository extends Repository<'notes'> {
  static table = 'notes' as const;
  static timestamps = true;

  latestOf(userId: number) {
    return this.query().selectAll().where('user_id', '=', userId).orderBy('updated_at', 'desc').limit(10).execute();
  }
}
```

`notes` is typed from the app's migrations (`marmeon db:types`): a column that does not exist is a compile error.

## Documentation

- [Database: Getting Started](https://github.com/marmeon/marmeon/blob/main/docs/database.md)
- [Repositories & Queries](https://github.com/marmeon/marmeon/blob/main/docs/queries.md)
- [Migrations](https://github.com/marmeon/marmeon/blob/main/docs/migrations.md)
- [Seeding & Factories](https://github.com/marmeon/marmeon/blob/main/docs/seeding.md)
- [Transactions](https://github.com/marmeon/marmeon/blob/main/docs/transactions.md)
- [Pagination](https://github.com/marmeon/marmeon/blob/main/docs/pagination.md)
- [Database Testing](https://github.com/marmeon/marmeon/blob/main/docs/database-testing.md)
- [Deployment: drivers](https://github.com/marmeon/marmeon/blob/main/docs/deployment.md#drivers-what-an-app-installs)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
