import { Controller, type HttpContext } from '@marmeon/http';
import type { Authenticated } from '@marmeon/auth';
import { HOME } from '../home.ts';

/** Where verified() sends people whose address is not confirmed yet. */
export class ShowVerifyEmailNoticeController extends Controller {
  handle(ctx: HttpContext<Authenticated>) {
    if (ctx.user.email_verified_at !== null) return this.redirect().route(HOME);
    return this.view('auth/VerifyEmail', { email: ctx.user.email });
  }
}
