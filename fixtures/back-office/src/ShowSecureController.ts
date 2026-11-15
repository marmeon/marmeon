import { Controller } from '@marmeon/http';

/** A page that only the editor's sudo window opens. */
export class ShowSecureController extends Controller {
  handle() {
    return this.view('office::Secure', {});
  }
}
