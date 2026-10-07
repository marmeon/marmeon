import { defineRoutes } from '@marmeon/http';
import { UpdateLocaleController } from './controllers/UpdateLocaleController.ts';

export default defineRoutes((Route) => {
  // A POST (with the CSRF token), never a GET: a link on another site must not switch the language.
  Route.post('/locale', UpdateLocaleController).name('locale.update');
});
