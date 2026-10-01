import { Registered } from '@bespokecore/auth';
import { defineModule, listen } from '@bespokecore/core';
import { SendEmailVerification } from './listeners/SendEmailVerification.ts';
import { AuthServiceProvider } from './AuthServiceProvider.ts';
import { DemoUsersSeeder } from './seeders/DemoUsersSeeder.ts';
import routes from './routes.ts';

// Public API of the auth module. Other modules import from here, never from internals.
export { UserFactory } from './factories/UserFactory.ts';
export { UserRepository } from './UserRepository.ts';
export type { User } from './users.ts';

export default defineModule({
  name: 'auth',
  providers: [AuthServiceProvider],
  listeners: [listen(Registered, SendEmailVerification)],
  migrations: new URL('./migrations/', import.meta.url),
  // Other modules may read and join `users` — writing goes through the UserRepository.
  exposes: ['users'],
  seeders: [DemoUsersSeeder],
  routes,
});
