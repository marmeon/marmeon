import type { Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';
import { Session } from '@bespokecore/session';

export class RedirectToOwnProfileController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle(ctx: HttpContext<Authenticated>) {
    // Only a hop: messages flashed for "your profile" (verified, signed in …) belong to the page after it.
    this.#session.reflash();
    return this.redirect().route('user-profile.show', { user: ctx.user.id });
  }
}
