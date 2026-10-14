import { defineRoutes, everyone } from '@marmeon/http';
import { UpdateLocaleController } from './controllers/UpdateLocaleController.ts';

export default defineRoutes((Route) => {
  // A POST (with the CSRF token), never a GET: a link on another site must not switch the language.
  // Open to everyone: it sets the visitor's own language (session, cookie) and touches no record.
  Route.authorize(everyone).post('/locale', UpdateLocaleController).name('locale.update');
});
