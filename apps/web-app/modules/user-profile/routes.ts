import { authenticate, verified } from '@bespokecore/auth';
import { defineRoutes } from '@bespokecore/http';
import { UserRepository } from '#modules/auth';
import { AddProfileLinkController } from './controllers/AddProfileLinkController.ts';
import { ConfirmRemoveLinkController } from './controllers/ConfirmRemoveLinkController.ts';
import { DeleteProfileLinkController } from './controllers/DeleteProfileLinkController.ts';
import { EditUserProfileController } from './controllers/EditUserProfileController.ts';
import { ListPeopleController } from './controllers/ListPeopleController.ts';
import { RedirectToOwnProfileController } from './controllers/RedirectToOwnProfileController.ts';
import { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import { UpdateUserProfileController } from './controllers/UpdateUserProfileController.ts';
import { ProfileDirectory } from './ProfileDirectory.ts';
import { ProfileLinkRepository } from './ProfileLinkRepository.ts';

export default defineRoutes((Route) => {
  // Everyone, filtered and sorted by the query string (`ListPeopleRequest`) — state that lives in the URL.
  Route.middleware(authenticate()).get('/people', ListPeopleController).name('user-profile.people');

  const users = Route.prefix('/users').middleware(authenticate()).name('user-profile.');
  users.get('/me', RedirectToOwnProfileController).name('me');

  // The profile page reads through the module's own read model; editing goes through auth's repository.
  users.bind('user', ProfileDirectory).get('/:user', ShowUserProfileController).name('show');
  const user = users.bind('user', UserRepository);
  // A layer over whatever is on screen (E53); its base, for deep links, is the profile.
  user.get('/:user/edit', EditUserProfileController).name('edit');
  user.put('/:user', UpdateUserProfileController).name('update');

  // A link is looked up *within* its user: another user's link id under this user is a 404 (no IDOR).
  // Publishing links needs a confirmed address.
  user.middleware(verified()).post('/:user/links', AddProfileLinkController).name('links.store');
  const link = user.bind('link', ProfileLinkRepository, { scopedBy: 'user' });
  link.get('/:user/links/:link/remove', ConfirmRemoveLinkController).name('links.remove'); // the confirmation, a layer
  link.delete('/:user/links/:link', DeleteProfileLinkController).name('links.destroy');
});
