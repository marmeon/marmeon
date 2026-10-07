import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';

/** Where people land after signing in — replace it with your app. */
export class ShowDashboardController extends Controller {
  handle(ctx: HttpContext<Authenticated>) {
    return this.view('auth/Dashboard', { name: ctx.user.name, verified: ctx.user.email_verified_at !== null });
  }
}
