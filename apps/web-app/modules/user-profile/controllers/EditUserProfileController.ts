import { abort, Controller, type HttpContext } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import type { AuthState, User } from '#modules/auth';

export class EditUserProfileController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle(ctx: HttpContext<AuthState, { user: User }>) {
    const { user } = ctx.params;
    if (ctx.user.id !== user.id) abort(403, 'You can only edit your own profile.');

    return this.view('user-profile/Edit', {
      profile: { id: user.id, name: user.name, bio: user.bio },
      // A failed submit without JavaScript comes back here: refill the fields from old().
      old: this.#session.old() as { name?: string; bio?: string },
    });
  }
}
