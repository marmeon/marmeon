import { defineRoutes, everyone } from '@marmeon/http';
import { ShowHomeController } from './controllers/ShowHomeController.ts';

// Loaded into the `web` middleware group: the session (and with it the signed-in user) comes with it.
export default defineRoutes((Route) => {
  // The home page is for visitors and signed-in people alike, and it binds no record. A route you add needs its own decision:
  // `authorize: can(Policy, …)` in its request, `Route.authorize(…)` on its registrar, or `everyone` if anyone may call it.
  Route.authorize(everyone).get('/', ShowHomeController).name('home');
});
