import { Controller, type HttpContext } from '@bespokecore/http';
import type { AuthState } from '#modules/auth';

export class RedirectToOwnProfileController extends Controller {
  handle(ctx: HttpContext<AuthState>) {
    return this.redirect().route('user-profile.show', { user: ctx.user.id });
  }
}
