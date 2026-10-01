import { Controller, type HttpContext } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import { RESET_COOKIE, resetFromCookie } from '../reset-cookie.ts';

/**
 * The link from the mail. Its token is taken out of the URL at once — into an encrypted, HttpOnly
 * cookie for this path only — and the browser is sent to the same page without it: the token stays
 * out of the browser history, the page's props and the Referer of anything the page loads.
 */
export class ShowResetPasswordController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle(ctx: HttpContext) {
    const token = ctx.query.get('token');
    const email = ctx.query.get('email');
    if (token && email) {
      ctx.cookies.set(RESET_COOKIE, JSON.stringify({ email: email.trim().toLowerCase(), token }), {
        path: '/reset-password',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60,
      });
      return this.redirect('/reset-password');
    }
    const reset = resetFromCookie(ctx.cookies.get(RESET_COOKIE));
    return this.view('auth/ResetPassword', { email: reset?.email ?? null, csrfToken: this.#session.token() });
  }
}
