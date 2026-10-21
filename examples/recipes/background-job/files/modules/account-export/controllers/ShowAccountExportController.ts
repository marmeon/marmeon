import { Controller } from '@marmeon/http';

/** The page with the button that asks for the mail. */
export class ShowAccountExportController extends Controller {
  handle() {
    return this.view('account-export/ShowAccountExport', {});
  }
}
