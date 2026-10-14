import { abilities, authenticate } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ListUsersController } from './controllers/ListUsersController.ts';

// Loaded into the stateless `api` group under /api — no cookies, no session: API tokens.
export default defineRoutes((Route) => {
  // `abilities('users:read')` limits what a token may do, not who may see which record: it is not a decision. This list is open to
  // every token with that ability, and shows ids and names.
  Route.middleware(authenticate('api')).middleware(abilities('users:read')).authorize(everyone).get('/users', ListUsersController).name('api.users.index');
});
