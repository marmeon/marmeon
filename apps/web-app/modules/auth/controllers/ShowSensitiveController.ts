import { Controller } from '@marmeon/http';

/** An example of a page behind `twoFactor()`: it opens only for a session that proved its second factor in the last 15 minutes. */
export class ShowSensitiveController extends Controller {
  handle() {
    return this.view('auth/Sensitive', {});
  }
}
