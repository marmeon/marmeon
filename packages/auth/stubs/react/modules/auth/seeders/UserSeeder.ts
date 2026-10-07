import { Hasher } from '@marmeon/auth';
import type { SeedContext } from '@marmeon/database';
import { UserFactory } from '../factories/UserFactory.ts';

/** A user to sign in with: test@example.com, password `password`. `marmeon migrate:fresh --seed` */
export class UserSeeder {
  readonly #hasher: Hasher;

  constructor(hasher: Hasher) {
    this.#hasher = hasher;
  }

  async handle({ factory }: SeedContext) {
    // Hashed with the configured costs — not the factory's cheap test hash.
    await factory(UserFactory).create({ name: 'Test User', email: 'test@example.com', password: await this.#hasher.make('password') });
  }
}
