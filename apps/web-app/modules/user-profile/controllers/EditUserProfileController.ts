import { Gate, type Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import type { User } from '#modules/auth';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { ProfileDirectory } from '../ProfileDirectory.ts';

/**
 * Editing a profile — a layer (E53): opened from a page, it shows over that page (a modal), with a history entry of its own
 * (Back closes it). A deep link or a reload of `/users/:user/edit` shows its base, the profile, under it.
 */
export class EditUserProfileController extends Controller {
  readonly #session: Session;
  readonly #gate: Gate;
  readonly #directory: ProfileDirectory;

  constructor(session: Session, gate: Gate, directory: ProfileDirectory) {
    super();
    this.#session = session;
    this.#gate = gate;
    this.#directory = directory;
  }

  async handle(ctx: HttpContext<Authenticated, { user: User }>) {
    const { user } = ctx.params;
    // The layer's own authorization — whatever page it opens over (a GET without a request schema: the Gate in code).
    await this.#gate.authorize(ProfilePolicy, 'update', user);

    return this.view('user-profile/Edit', {
      profile: { id: user.id, name: user.name, bio: user.bio, links: await this.#directory.links(user.id) },
      // A failed submit without JavaScript comes back here: refill the fields from old().
      old: this.#session.old() as { name?: string; bio?: string },
    }).layer({ base: 'user-profile.show', params: { user: user.id } });
  }
}
