import { Hasher } from '@bespokecore/auth';
import type { SeedContext } from '@bespokecore/database';
import { UserFactory } from '../factories/UserFactory.ts';

/** The three demo people — each signs in with the password `password`. `bespoke migrate:fresh --seed` */
export class DemoUsersSeeder {
  readonly #hasher: Hasher;

  constructor(hasher: Hasher) {
    this.#hasher = hasher;
  }

  async handle({ factory }: SeedContext) {
    // With the configured costs (OWASP outside tests), not the factory's cheap test hash — and one
    // hash per person: a shared hash would show in the database that they share the password.
    const users = factory(UserFactory);
    const password = () => this.#hasher.make('password');
    await users.create({ name: 'Ada Lovelace', email: 'ada@example.com', bio: 'First programmer.', password: await password() });
    await users.create({ name: 'Alan Turing', email: 'alan@example.com', bio: 'Computability pioneer.', password: await password() });
    await users.create({ name: 'Grace Hopper', email: 'grace@example.com', bio: 'Compiler inventor.', password: await password() });
  }
}
