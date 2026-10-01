import { Controller, type HttpContext } from '@bespokecore/http';
import type { Authenticated } from '@bespokecore/auth';

export class RedirectToOwnProfileController extends Controller {
  handle(ctx: HttpContext<Authenticated>) {
    return this.redirect().route('user-profile.show', { user: ctx.user.id });
  }
}
