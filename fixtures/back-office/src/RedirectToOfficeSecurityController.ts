import { Controller } from '@marmeon/http';

/** The recovery codes are an answer to a POST, shown once; a reload asks that address with a GET. The answer is the security page, never the codes. */
export class RedirectToOfficeSecurityController extends Controller {
  handle() {
    return this.redirect().route('office.security');
  }
}
