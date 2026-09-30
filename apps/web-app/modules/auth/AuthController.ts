import { BaseController, type HttpContext } from '@bespokecore/core';
import { SESSION_COOKIE } from './middleware.ts';
import { allUsers, findUser } from './users.ts';

export class AuthController extends BaseController {
  show() {
    return this.view('auth/Login', {
      users: allUsers().map(({ id, name }) => ({ id, name })),
    });
  }

  async login(ctx: HttpContext) {
    const form = await ctx.request.formData();
    const user = findUser(String(form.get('user_id') ?? ''));
    if (!user) return this.redirect('/login', 303);

    const response = this.redirect('/users/me', 303);
    response.headers.append('set-cookie', `${SESSION_COOKIE}=${user.id}; Path=/; HttpOnly; SameSite=Lax`);
    return response;
  }

  logout() {
    const response = this.redirect('/login', 303);
    response.headers.append('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    return response;
  }
}
