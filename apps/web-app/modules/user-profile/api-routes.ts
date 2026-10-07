import { abilities, authenticate } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ListUsersController } from './controllers/ListUsersController.ts';

// Loaded into the stateless `api` group under /api — no cookies, no session: API tokens (E27).
export default defineRoutes((Route) => {
  Route.middleware(authenticate('api')).middleware(abilities('users:read')).get('/users', ListUsersController).name('api.users.index');
});
