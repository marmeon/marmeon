import { Controller, type HttpContext } from '@bespokecore/http';
import { SESSION_COOKIE } from '../middleware.ts';

export class LogoutController extends Controller {
  handle(ctx: HttpContext) {
    ctx.cookies.delete(SESSION_COOKIE);
    return this.redirect().route('auth.login');
  }
}
