import { Controller } from '@marmeon/http';

export class ShowForgotPasswordController extends Controller {
  handle() {
    return this.view('auth/ForgotPassword', {});
  }
}
