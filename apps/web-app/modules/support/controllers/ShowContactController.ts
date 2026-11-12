import { Controller } from '@marmeon/http';

/** `/:locale/help/contact`: how to reach the support — a page of its own beside the help pages the fallback answers. */
export class ShowContactController extends Controller {
  handle() {
    return this.view('support/Contact', { email: 'support@example.com' });
  }
}
