import { Controller, type HttpContext } from '@bespokecore/http';
import { allUsers, findUser, type AuthState } from '#modules/auth';

export class ShowUserProfileController extends Controller {
  handle(ctx: HttpContext<AuthState, { id: string }>) {
    const user = findUser(ctx.params.id);
    if (!user) return this.json({ message: 'User not found.' }, 404);

    return this.view('user-profile/Show', {
      profile: { id: user.id, name: user.name, bio: user.bio },
      // Only the owner may see their e-mail — the controller decides what leaves the server.
      email: ctx.user.id === user.id ? user.email : null,
      isOwnProfile: ctx.user.id === user.id,
      viewer: { name: ctx.user.name },
      others: allUsers()
        .filter((other) => other.id !== user.id)
        .map(({ id, name }) => ({ id, name })),
    });
  }
}
