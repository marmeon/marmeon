import { defineRoutes } from '@bespokecore/core';
import { authenticate } from '#modules/auth';
import { UserProfileController } from './UserProfileController.ts';

export default defineRoutes((Route) => {
  Route.prefix('/users')
    .middleware(authenticate)
    .name('user-profile.')
    .group((Route) => {
      Route.get('/me', [UserProfileController, 'me']).name('me');
      Route.get('/:id', [UserProfileController, 'show']).name('show');
    });
});
