import { Controller } from '@marmeon/http';

/** The sudo mode's page: `confirmedPassword()` sends editors here before a sensitive action. */
export class ShowConfirmController extends Controller {
  handle() {
    return this.view('office::Confirm', {});
  }
}
