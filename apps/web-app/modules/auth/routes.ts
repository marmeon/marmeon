import { defineRoutes, EncryptCookies } from '@bespokecore/http';
import { StartSession } from '@bespokecore/session';
import { LoginController } from './controllers/LoginController.ts';
import { LogoutController } from './controllers/LogoutController.ts';
import { ShowLoginController } from './controllers/ShowLoginController.ts';

export default defineRoutes((Route) => {
  // EncryptCookies and StartSession move into the `web` middleware group once groups exist (Wave 2, step 4).
  Route.middleware(EncryptCookies).middleware(StartSession).group((Route) => {
    Route.get('/', ShowLoginController);
    Route.name('auth.').group((Route) => {
      Route.get('/login', ShowLoginController).name('login');
      Route.post('/login', LoginController).name('login.store');
      Route.post('/logout', LogoutController).name('logout');
    });
  });
});
