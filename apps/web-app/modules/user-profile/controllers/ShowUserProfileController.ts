import { Controller, type HttpContext } from '@bespokecore/http';
import { UserRepository, type AuthState } from '#modules/auth';

export class ShowUserProfileController extends Controller {
  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    super();
    this.#users = users;
  }

  handle(ctx: HttpContext<AuthState, { id: string }>) {
    const user = this.#users.find(ctx.params.id);
    if (!user) return this.json({ message: 'User not found.' }, 404);

    return this.view('user-profile/Show', {
      profile: { id: user.id, name: user.name, bio: user.bio },
      // Only the owner may see their e-mail — the controller decides what leaves the server.
      email: ctx.user.id === user.id ? user.email : null,
      isOwnProfile: ctx.user.id === user.id,
      viewer: { name: ctx.user.name },
      others: this.#users
        .all()
        .filter((other) => other.id !== user.id)
        .map(({ id, name }) => ({ id, name })),
    });
  }
}
