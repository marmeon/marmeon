import { Controller } from '@bespokecore/http';

/** After a sign-up (E146): the same page for a new and a known address — the mail tells the rest. */
export class ShowRegistrationSentController extends Controller {
  handle() {
    return this.view('auth/RegistrationSent', {});
  }
}
