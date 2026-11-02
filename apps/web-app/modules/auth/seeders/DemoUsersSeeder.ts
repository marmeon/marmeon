import { Hasher } from '@marmeon/auth';
import { environment } from '@marmeon/core';
import type { SeedContext } from '@marmeon/database';
import { UserFactory } from '../factories/UserFactory.ts';

/**
 * The three demo people — each signs in with the password `password`. `marmeon migrate:fresh --seed`. A known password is a way
 * in for anyone, so it refuses to run where the app is protected: `--force` is all `db:seed` asks for there.
 */
export class DemoUsersSeeder {
  readonly #hasher: Hasher;

  constructor(hasher: Hasher) {
    this.#hasher = hasher;
  }

  async handle({ factory }: SeedContext) {
    if (environment.isProtected()) {
      throw new Error(
        'DemoUsersSeeder creates three people with the password "password", so it runs only in development and tests (NODE_ENV=development or test). Seed another module with `marmeon db:seed --module=<name> --force`, or delete this seeder.',
      );
    }
    // With the configured costs (OWASP outside tests), not the factory's cheap test hash — and one
    // hash per person: a shared hash would show in the database that they share the password.
    const users = factory(UserFactory); // verified addresses: the factory's default
    const password = () => this.#hasher.make('password');
    await users.create({ name: 'Ada Lovelace', email: 'ada@example.com', bio: 'First programmer.', password: await password() });
    await users.create({ name: 'Alan Turing', email: 'alan@example.com', bio: 'Computability pioneer.', password: await password() });
    await users.create({ name: 'Grace Hopper', email: 'grace@example.com', bio: 'Compiler inventor.', password: await password() });
  }
}
