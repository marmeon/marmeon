import { Controller } from '@marmeon/http';

/** A layer that answered a POST is shown once; Forward asks its URL with a GET. The answer is the settings page, never the codes. */
export class RedirectToTwoFactorController extends Controller {
  handle() {
    return this.redirect().route('auth.two-factor');
  }
}
