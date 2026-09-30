import { Controller } from '@bespokecore/http';
import { allUsers } from '../users.ts';

export class ShowLoginController extends Controller {
  handle() {
    return this.view('auth/Login', {
      users: allUsers().map(({ id, name }) => ({ id, name })),
    });
  }
}
