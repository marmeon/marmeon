import { Controller, type HttpContext } from '@bespokecore/http';
import type { Authenticated } from '@bespokecore/auth';
import { Session } from '@bespokecore/session';

/** Where verified() sends people whose address is not confirmed yet. */
export class ShowVerifyEmailNoticeController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle(ctx: HttpContext<Authenticated>) {
    if (ctx.user.email_verified_at !== null) return this.redirect().route('dashboard');
    return this.view('auth/VerifyEmail', { email: ctx.user.email, csrfToken: this.#session.token() });
  }
}
