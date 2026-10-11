import { Controller } from '@marmeon/http';

/** `/`: the landing page. */
export class ShowLandingController extends Controller {
  handle() {
    return this.view('site/Landing', {});
  }
}
