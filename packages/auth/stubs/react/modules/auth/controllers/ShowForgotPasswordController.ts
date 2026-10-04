import { Controller } from '@bespokecore/http';

export class ShowForgotPasswordController extends Controller {
  handle() {
    return this.view('auth/ForgotPassword', {});
  }
}
