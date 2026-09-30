import { abort, Controller, type HttpContext } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import { UserRepository, type AuthState } from '#modules/auth';

export class EditUserProfileController extends Controller {
  readonly #users: UserRepository;
  readonly #session: Session;

  constructor(users: UserRepository, session: Session) {
    super();
    this.#users = users;
    this.#session = session;
  }

  handle(ctx: HttpContext<AuthState, { id: string }>) {
    if (ctx.user.id !== ctx.params.id) abort(403, 'You can only edit your own profile.');
    const user = this.#users.find(ctx.params.id) ?? abort(404, 'User not found.');

    return this.view('user-profile/Edit', {
      profile: { id: user.id, name: user.name, bio: user.bio },
      // A failed submit without JavaScript comes back here: refill the fields from old().
      old: this.#session.old() as { name?: string; bio?: string },
      errors: this.#session.get('errors') ?? {},
    });
  }
}
