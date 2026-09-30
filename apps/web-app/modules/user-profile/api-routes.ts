import { defineRoutes } from '@bespokecore/http';
import { ListUsersController } from './controllers/ListUsersController.ts';

// Loaded into the stateless `api` group under /api — no cookies, no session.
export default defineRoutes((Route) => {
  Route.get('/users', ListUsersController).name('api.users.index');
});
