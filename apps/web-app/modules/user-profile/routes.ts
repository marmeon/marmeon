import { defineRoutes, EncryptCookies } from '@bespokecore/http';
import { StartSession } from '@bespokecore/session';
import { Authenticate } from '#modules/auth';
import { RedirectToOwnProfileController } from './controllers/RedirectToOwnProfileController.ts';
import { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';

export default defineRoutes((Route) => {
  Route.prefix('/users')
    .middleware(EncryptCookies) // → `web` group in step 4
    .middleware(StartSession)
    .middleware(Authenticate)
    .name('user-profile.')
    .group((Route) => {
      Route.get('/me', RedirectToOwnProfileController).name('me');
      Route.get('/:id', ShowUserProfileController).name('show');
    });
});
