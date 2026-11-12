import { defineRoutes, everyone } from '@marmeon/http';
import { ShowContactController } from './controllers/ShowContactController.ts';

export default defineRoutes((Route) => {
  // The help module's fallback answers every path below `/help`, and its module loads first. A route registered here still wins
  // for its own path: the server registers fallbacks after every other route, whatever order the modules load in.
  Route.authorize(everyone).get('/help/contact', ShowContactController).name('support.contact');
});
