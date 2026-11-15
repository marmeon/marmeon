import { Controller } from '@marmeon/http';

/** The editors' sign-in page. */
export class ShowOfficeLoginController extends Controller {
  handle() {
    return this.view('office::Login', {});
  }
}
