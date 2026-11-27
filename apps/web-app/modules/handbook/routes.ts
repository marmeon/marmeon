import { defineRoutes, everyone } from '@marmeon/http';
import { SearchHandbookController } from './controllers/SearchHandbookController.ts';

// Open to everyone: what a visitor finds is decided by the search's audience filter, in the controller.
export default defineRoutes((Route) => {
  Route.authorize(everyone).get('/handbook/search', SearchHandbookController).name('handbook.search');
});
