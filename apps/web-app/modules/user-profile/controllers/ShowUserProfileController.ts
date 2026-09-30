import { abort, Controller, type HttpContext } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import { UserRepository, type AuthState } from '#modules/auth';
import { ProfileActivity } from '../ProfileActivity.ts';

export class ShowUserProfileController extends Controller {
  readonly #users: UserRepository;
  readonly #activity: ProfileActivity;
  readonly #session: Session;

  constructor(users: UserRepository, activity: ProfileActivity, session: Session) {
    super();
    this.#users = users;
    this.#activity = activity;
    this.#session = session;
  }

  handle(ctx: HttpContext<AuthState, { id: string }>) {
    const user = this.#users.find(ctx.params.id) ?? abort(404, 'User not found.');
    const filter = ctx.query.get('q')?.trim() ?? '';

    return this.view('user-profile/Show', {
      profile: { id: user.id, name: user.name, bio: user.bio },
      // Only the owner may see their e-mail — the controller decides what leaves the server.
      email: ctx.user.id === user.id ? user.email : null,
      isOwnProfile: ctx.user.id === user.id,
      viewer: { name: ctx.user.name },
      lastLoginAt: this.#activity.lastLogin(user.id)?.toISOString() ?? null,
      filter,
      status: this.#session.get('status') ?? null, // flashed by the previous request (e.g. after saving)
      others: this.#users
        .all()
        .filter((other) => other.id !== user.id && other.name.toLowerCase().includes(filter.toLowerCase()))
        .map(({ id, name }) => ({ id, name })),
    });
  }
}
