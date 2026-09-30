import { defineModule } from '@bespokecore/core';
import { AuthServiceProvider } from './AuthServiceProvider.ts';
import routes from './routes.ts';

// Public API of the auth module. Other modules import from here, never from internals.
export { UserLoggedIn } from './events/UserLoggedIn.ts';
export { Authenticate, type AuthState } from './middleware.ts';
export { UserRepository } from './UserRepository.ts';
export type { User } from './users.ts';

export default defineModule({
  name: 'auth',
  providers: [AuthServiceProvider],
  migrations: new URL('./migrations/', import.meta.url),
  routes,
});
