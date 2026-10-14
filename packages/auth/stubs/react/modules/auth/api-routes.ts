import { authenticate } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';

// The stateless `api` group under /api: API tokens instead of the session.
export default defineRoutes((Route) => {
  // Who the token belongs to: the account it was created for.
  // Anyone with a token may ask: it answers only for the token's own account.
  Route.middleware(authenticate('api')).authorize(everyone).get('/user', (ctx) => ({ id: ctx.user.id, name: ctx.user.name, email: ctx.user.email })).name('api.user');
});
