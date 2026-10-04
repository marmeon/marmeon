import { Controller, type HttpContext } from '@bespokecore/http';
import type { Authenticated } from '@bespokecore/auth';

/** Where verified() sends people whose address is not confirmed yet. */
export class ShowVerifyEmailNoticeController extends Controller {
  handle(ctx: HttpContext<Authenticated>) {
    if (ctx.user.email_verified_at !== null) return this.redirect().route('dashboard');
    return this.view('auth/VerifyEmail', { email: ctx.user.email });
  }
}
