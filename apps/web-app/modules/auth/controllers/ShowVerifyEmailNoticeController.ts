import { Controller, type HttpContext } from '@marmeon/http';
import type { Authenticated } from '@marmeon/auth';
import { Router } from '@marmeon/router';
import { HOME } from '../home.ts';

/** Where verified() sends people whose address is not confirmed yet. */
export class ShowVerifyEmailNoticeController extends Controller {
  readonly #router: Router;

  constructor(router: Router) {
    super();
    this.#router = router;
  }

  handle(ctx: HttpContext<Authenticated>) {
    if (ctx.user.email_verified_at !== null) return this.redirect().route(HOME);
    return this.view('auth/VerifyEmail', { email: ctx.user.email, home: this.#router.url(HOME) });
  }
}
