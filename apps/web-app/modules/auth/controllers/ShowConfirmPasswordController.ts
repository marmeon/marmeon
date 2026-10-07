import { Controller } from '@marmeon/http';

/** "Sudo mode": shown by confirmedPassword() before sensitive pages. */
export class ShowConfirmPasswordController extends Controller {
  handle() {
    return this.view('auth/ConfirmPassword', {});
  }
}
