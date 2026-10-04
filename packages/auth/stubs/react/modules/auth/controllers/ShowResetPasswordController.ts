import { Controller, type HttpContext } from '@bespokecore/http';
import { Router } from '@bespokecore/router';
import { RESET_COOKIE, resetFromCookie } from '../reset-cookie.ts';

/**
 * The link from the mail. Its token is taken out of the URL at once — into an encrypted, HttpOnly
 * cookie for this path only — and the browser is sent to the same page without it: the token stays
 * out of the browser history, the page's props and the Referer of anything the page loads.
 */
export class ShowResetPasswordController extends Controller {
  readonly #router: Router;

  constructor(router: Router) {
    super();
    this.#router = router;
  }

  handle(ctx: HttpContext) {
    const token = ctx.query.get('token');
    const email = ctx.query.get('email');
    if (token && email) {
      ctx.cookies.set(RESET_COOKIE, JSON.stringify({ email: email.trim().toLowerCase(), token }), {
        path: this.#router.url('auth.password.reset'),
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60,
      });
      return this.redirect().route('auth.password.reset');
    }
    const reset = resetFromCookie(ctx.cookies.get(RESET_COOKIE));
    return this.view('auth/ResetPassword', { email: reset?.email ?? null });
  }
}
