import { Controller, type HttpContext } from '@bespokecore/http';
import { SESSION_COOKIE } from '../middleware.ts';
import { findUser } from '../users.ts';

export class LoginController extends Controller {
  async handle(ctx: HttpContext) {
    const form = await ctx.request.formData();
    const user = findUser(String(form.get('user_id') ?? ''));
    if (!user) return this.redirect('/login', 303);

    const response = this.redirect('/users/me', 303);
    response.headers.append('set-cookie', `${SESSION_COOKIE}=${user.id}; Path=/; HttpOnly; SameSite=Lax`);
    return response;
  }
}
