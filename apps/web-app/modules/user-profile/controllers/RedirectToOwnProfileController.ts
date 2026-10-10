import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Session } from '@marmeon/session';

export class RedirectToOwnProfileController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle(ctx: HttpContext<Authenticated>) {
    // Only a hop: data flashed with `with()` belongs to the page after it. (Flash messages — `flash()` — wait for a shown
    // answer anyway: a redirect never takes them.)
    this.#session.reflash();
    return this.redirect().route('user-profile.show', { user: ctx.user.id });
  }
}
