import { Hasher } from '@marmeon/auth';
import { environment } from '@marmeon/core';
import { Connections, sql } from '@marmeon/database';

/**
 * The back office's two editors, with the ids of the customers Ada and Alan of the app (the same id is two people): Eve publishes, Victor only looks. Each signs in
 * to the back office with the password `password`. Like the demo customers, it refuses to run where the app is protected.
 */
export class OfficeUsersSeeder {
  readonly #connections: Connections;
  readonly #hasher: Hasher;

  constructor(connections: Connections, hasher: Hasher) {
    this.#connections = connections;
    this.#hasher = hasher;
  }

  async handle() {
    if (environment.isProtected()) {
      throw new Error('OfficeUsersSeeder creates two editors with the password "password", so it runs only in development and tests (NODE_ENV=development or test). Delete this seeder, or seed with `marmeon db:seed --module=<name> --force`.');
    }
    const db = this.#connections.get();
    // The editors take the ids of the customers Ada and Alan, so the same id is two people in both tables: the collision the back office is built for.
    const customers = await db.selectFrom('users').select(['id', 'email']).where('email', 'in', ['ada@example.com', 'alan@example.com']).execute();
    const idOf = (email: string) => customers.find((customer) => customer.email === email)?.id;
    for (const [name, email, role, like] of [['Eve Editor', 'eve@office.example.com', 'editor', 'ada@example.com'], ['Victor Viewer', 'victor@office.example.com', 'viewer', 'alan@example.com']] as const) {
      const id = idOf(like);
      await db.insertInto('office_users').values({ ...(id === undefined ? {} : { id }), name, email, role, password: await this.#hasher.make('password') }).execute();
    }
    // An explicit id leaves the sequence of Postgres behind: move it past the rows, or the next editor would take a seeded id.
    if (this.#connections.options().driver === 'pgsql') await sql`select setval(pg_get_serial_sequence('office_users', 'id'), (select max(id) from office_users))`.execute(db);
  }
}
