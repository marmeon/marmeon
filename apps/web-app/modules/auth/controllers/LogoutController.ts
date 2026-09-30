import { Controller } from '@bespokecore/http';
import { SESSION_COOKIE } from '../middleware.ts';

export class LogoutController extends Controller {
  handle() {
    const response = this.redirect('/login', 303);
    response.headers.append('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    return response;
  }
}
