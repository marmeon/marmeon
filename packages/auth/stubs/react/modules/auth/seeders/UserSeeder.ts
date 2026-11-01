import { Hasher } from '@marmeon/auth';
import { environment } from '@marmeon/core';
import type { SeedContext } from '@marmeon/database';
import { UserFactory } from '../factories/UserFactory.ts';

/**
 * A user to sign in with: test@example.com, password `password`. `marmeon migrate:fresh --seed`. A known password is a way in for
 * anyone, so it refuses to run where the app is protected: `--force` is all `db:seed` asks for there.
 */
export class UserSeeder {
  readonly #hasher: Hasher;

  constructor(hasher: Hasher) {
    this.#hasher = hasher;
  }

  async handle({ factory }: SeedContext) {
    if (environment.isProtected()) {
      throw new Error(
        'UserSeeder creates test@example.com with the password "password", so it runs only in development and tests (NODE_ENV=development or test). Seed another module with `marmeon db:seed --module=<name> --force`, or delete this seeder.',
      );
    }
    // Hashed with the configured costs — not the factory's cheap test hash.
    await factory(UserFactory).create({ name: 'Test User', email: 'test@example.com', password: await this.#hasher.make('password') });
  }
}
