import { defineRoutes } from '@bespokecore/http';
import { authenticate } from '#modules/auth';
import { RedirectToOwnProfileController } from './controllers/RedirectToOwnProfileController.ts';
import { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';

export default defineRoutes((Route) => {
  Route.prefix('/users')
    .middleware(authenticate)
    .name('user-profile.')
    .group((Route) => {
      Route.get('/me', RedirectToOwnProfileController).name('me');
      Route.get('/:id', ShowUserProfileController).name('show');
    });
});
