import { Gate, type Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import type { User } from '#modules/auth';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';

export class EditUserProfileController extends Controller {
  readonly #session: Session;
  readonly #gate: Gate;

  constructor(session: Session, gate: Gate) {
    super();
    this.#session = session;
    this.#gate = gate;
  }

  async handle(ctx: HttpContext<Authenticated, { user: User }>) {
    const { user } = ctx.params;
    await this.#gate.authorize(ProfilePolicy, 'update', user); // a GET without a request schema: the Gate in code

    return this.view('user-profile/Edit', {
      profile: { id: user.id, name: user.name, bio: user.bio },
      // A failed submit without JavaScript comes back here: refill the fields from old().
      old: this.#session.old() as { name?: string; bio?: string },
    });
  }
}
