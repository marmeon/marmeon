import { defineRoutes } from '@bespokecore/http';
import { LoginController } from './controllers/LoginController.ts';
import { LogoutController } from './controllers/LogoutController.ts';
import { ShowLoginController } from './controllers/ShowLoginController.ts';

export default defineRoutes((Route) => {
  Route.get('/', ShowLoginController);
  Route.name('auth.').group((Route) => {
    Route.get('/login', ShowLoginController).name('login');
    Route.post('/login', LoginController).name('login.store');
    Route.post('/logout', LogoutController).name('logout');
  });
});
