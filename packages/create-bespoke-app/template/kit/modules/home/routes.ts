import { defineRoutes } from '@bespokecore/http';
import { ShowHomeController } from './controllers/ShowHomeController.ts';

// Loaded into the `web` middleware group: the session (and with it the signed-in user) comes with it.
export default defineRoutes((Route) => {
  Route.get('/', ShowHomeController).name('home');
});
