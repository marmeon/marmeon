import type { SeedContext } from '@bespokecore/database';
import { UserFactory } from '../factories/UserFactory.ts';

/** The three people of the demo login. `bespoke migrate:fresh --seed` */
export class DemoUsersSeeder {
  async handle({ factory }: SeedContext) {
    const users = factory(UserFactory);
    await users.create({ name: 'Ada Lovelace', email: 'ada@example.com', bio: 'First programmer.' });
    await users.create({ name: 'Alan Turing', email: 'alan@example.com', bio: 'Computability pioneer.' });
    await users.create({ name: 'Grace Hopper', email: 'grace@example.com', bio: 'Compiler inventor.' });
  }
}
