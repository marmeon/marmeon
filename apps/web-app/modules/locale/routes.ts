import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { UpdateLocaleController } from './controllers/UpdateLocaleController.ts';

export default defineRoutes((Route) => {
  // A POST (with the CSRF token), never a GET: a link on another site must not switch the language.
  // Open to everyone, and limited per client: it writes the language into the session and, for a signed-in user, into that user's own
  // `locale`; it takes a supported language only.
  Route.middleware(throttle('locale')).authorize(everyone).post('/locale', UpdateLocaleController).name('locale.update');
});
