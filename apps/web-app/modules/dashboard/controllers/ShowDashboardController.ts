import { Controller } from '@bespokecore/http';

/**
 * `/dashboard`: a page of islands (E48). The page itself loads nothing — each panel is an island, a GET route of its
 * own with its own middleware, authorization and query, loaded by the browser after the page, in parallel.
 */
export class ShowDashboardController extends Controller {
  /** An instant visit (E64): the view's placeholder needs nothing — `<Link route="dashboard.show" instant>`. */
  declare readonly instant: {};

  handle() {
    return this.view('dashboard/Show', {});
  }
}
