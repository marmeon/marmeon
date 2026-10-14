import { authenticate, confirmedPassword, verified } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { UserRepository } from '#modules/auth';
import { AddProfileLinkController } from './controllers/AddProfileLinkController.ts';
import { ConfirmRemoveLinkController } from './controllers/ConfirmRemoveLinkController.ts';
import { DeleteProfileLinkController } from './controllers/DeleteProfileLinkController.ts';
import { EditUserProfileController } from './controllers/EditUserProfileController.ts';
import { ExportMyDataController } from './controllers/ExportMyDataController.ts';
import { ListPeopleController } from './controllers/ListPeopleController.ts';
import { RedirectToOwnProfileController } from './controllers/RedirectToOwnProfileController.ts';
import { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import { UpdateAvatarController } from './controllers/UpdateAvatarController.ts';
import { UpdateUserProfileController } from './controllers/UpdateUserProfileController.ts';
import { ProfileDirectory } from './ProfileDirectory.ts';
import { ProfileLinkRepository } from './ProfileLinkRepository.ts';

export default defineRoutes((Route) => {
  // Everyone, filtered and sorted by the query string (`ListPeopleRequest`) — state that lives in the URL.
  // A confirmed address first (private registration): an unconfirmed account sees the verification notice instead.
  const confirmed = Route.middleware(authenticate()).middleware(verified());
  // Open to every confirmed account on purpose: the directory is the point of the page, and it binds nothing.
  confirmed.authorize(everyone).get('/people', ListPeopleController).name('user-profile.people');

  const users = confirmed.prefix('/users').name('user-profile.');
  // Decided for the routes below only: they act on the signed-in account (`ctx.user`) and take no id from the path. A route you add
  // here needs its own decision.
  const mine = users.authorize(everyone);
  mine.get('/me', RedirectToOwnProfileController).name('me');
  // "Download my data" (security page): a file on the private disk, handed out by a signed URL for five minutes.
  mine.middleware(confirmedPassword()).post('/me/export', ExportMyDataController).name('export');

  // The profile page reads through the module's own read model; editing goes through auth's repository.
  // Every confirmed account may look at every profile: the binder is public for it, and the controller picks the fields that leave
  // the server (the e-mail only for the owner).
  users.authorize(everyone).bind('user', ProfileDirectory, { public: true }).get('/:user', ShowUserProfileController).name('show');
  // Everything below changes or opens a profile for editing, and each request checks ProfilePolicy (or ProfileLinkPolicy).
  const user = users.bind('user', UserRepository);
  // A layer over whatever is on screen; its base, for deep links, is the profile.
  user.get('/:user/edit', EditUserProfileController).name('edit');
  user.put('/:user', UpdateUserProfileController).name('update');
  // The picture, from the edit layer: uploaded ahead — this route hands out the upload target for its `avatar` field.
  user.put('/:user/avatar', UpdateAvatarController).name('avatar.update');

  // A link is looked up *within* its user: another user's link id under this user is a 404 (no IDOR).
  user.post('/:user/links', AddProfileLinkController).name('links.store');
  const link = user.bind('link', ProfileLinkRepository, { scopedBy: 'user' });
  link.get('/:user/links/:link/remove', ConfirmRemoveLinkController).name('links.remove'); // the confirmation, a layer
  link.delete('/:user/links/:link', DeleteProfileLinkController).name('links.destroy');
});
