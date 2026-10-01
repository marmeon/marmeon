import { authenticate, guest } from '@bespokecore/auth';
import { defineRoutes } from '@bespokecore/http';
import { LoginController } from './controllers/LoginController.ts';
import { LogoutController } from './controllers/LogoutController.ts';
import { ShowLoginController } from './controllers/ShowLoginController.ts';

// Loaded into the `web` middleware group: encrypted cookies and the session come with it.
export default defineRoutes((Route) => {
  // Guests only: signed-in people go to their profile.
  const guests = Route.middleware(guest('/users/me'));
  guests.get('/', ShowLoginController);
  guests.get('/login', ShowLoginController).name('auth.login');
  guests.post('/login', LoginController).name('auth.login.store');

  Route.middleware(authenticate()).post('/logout', LogoutController).name('auth.logout');
});
