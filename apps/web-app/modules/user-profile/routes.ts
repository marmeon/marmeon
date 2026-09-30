import { defineRoutes } from '@bespokecore/http';
import { Authenticate, UserRepository } from '#modules/auth';
import { AddProfileLinkController } from './controllers/AddProfileLinkController.ts';
import { DeleteProfileLinkController } from './controllers/DeleteProfileLinkController.ts';
import { EditUserProfileController } from './controllers/EditUserProfileController.ts';
import { RedirectToOwnProfileController } from './controllers/RedirectToOwnProfileController.ts';
import { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import { UpdateUserProfileController } from './controllers/UpdateUserProfileController.ts';
import { ProfileDirectory } from './ProfileDirectory.ts';
import { ProfileLinkRepository } from './ProfileLinkRepository.ts';

export default defineRoutes((Route) => {
  const users = Route.prefix('/users').middleware(Authenticate).name('user-profile.');
  users.get('/me', RedirectToOwnProfileController).name('me');

  // The profile page reads through the module's own read model; editing goes through auth's repository.
  users.bind('user', ProfileDirectory).get('/:user', ShowUserProfileController).name('show');
  const user = users.bind('user', UserRepository);
  user.get('/:user/edit', EditUserProfileController).name('edit');
  user.put('/:user', UpdateUserProfileController).name('update');

  // A link is looked up *within* its user: another user's link id under this user is a 404 (no IDOR).
  user.post('/:user/links', AddProfileLinkController).name('links.store');
  user.bind('link', ProfileLinkRepository, { scopedBy: 'user' }).delete('/:user/links/:link', DeleteProfileLinkController).name('links.destroy');
});
