import { defineRoutes } from '@bespokecore/http';
import { Authenticate } from '#modules/auth';
import { EditUserProfileController } from './controllers/EditUserProfileController.ts';
import { RedirectToOwnProfileController } from './controllers/RedirectToOwnProfileController.ts';
import { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import { UpdateUserProfileController } from './controllers/UpdateUserProfileController.ts';

export default defineRoutes((Route) => {
  Route.prefix('/users')
    .middleware(Authenticate)
    .name('user-profile.')
    .group((Route) => {
      Route.get('/me', RedirectToOwnProfileController).name('me');
      Route.get('/:id', ShowUserProfileController).name('show');
      Route.get('/:id/edit', EditUserProfileController).name('edit');
      Route.put('/:id', UpdateUserProfileController).name('update');
    });
});
