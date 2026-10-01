import { authenticate } from '@bespokecore/auth';
import { defineRoutes } from '@bespokecore/http';

// The stateless `api` group under /api: API tokens instead of the session.
export default defineRoutes((Route) => {
  // Who the token belongs to — Sanctum's `/api/user`.
  Route.middleware(authenticate('api')).get('/user', (ctx) => ({ id: ctx.user.id, name: ctx.user.name, email: ctx.user.email })).name('api.user');
});
