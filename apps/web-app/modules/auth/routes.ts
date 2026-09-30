import { defineRoutes } from '@bespokecore/core';
import { AuthController } from './AuthController.ts';

export default defineRoutes((Route) => {
  Route.get('/', [AuthController, 'show']);
  Route.name('auth.').group((Route) => {
    Route.get('/login', [AuthController, 'show']).name('login');
    Route.post('/login', [AuthController, 'login']).name('login.store');
    Route.post('/logout', [AuthController, 'logout']).name('logout');
  });
});
