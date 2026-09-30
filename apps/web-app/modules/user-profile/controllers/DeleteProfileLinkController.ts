import { abort, Controller, type HttpContext } from '@bespokecore/http';
import type { Row } from '@bespokecore/database';
import type { AuthState, User } from '#modules/auth';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

export class DeleteProfileLinkController extends Controller {
  readonly #links: ProfileLinkRepository;

  constructor(links: ProfileLinkRepository) {
    super();
    this.#links = links;
  }

  /** The route binds `link` scoped to `user`: it is this user's link, or the request never got here (404). */
  async handle(ctx: HttpContext<AuthState, { user: User; link: Row<'profile_links'> }>) {
    const { user, link } = ctx.params;
    if (ctx.user.id !== user.id) abort(403, 'You can only change your own profile.');
    await this.#links.delete(link.id);
    return this.redirect().route('user-profile.show', { user: user.id }).with('status', 'Link removed.');
  }
}
