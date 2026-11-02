import { Controller } from '@marmeon/http';
import { Router } from '@marmeon/router';

/**
 * `/dashboard/panels`: a page whose panels the server chooses. Each panel is an island route; the page gets its URL, built
 * with `router.url()`, and embeds it with `<Island href>`. A module that offers a panel adds one entry here.
 */
export class ShowPanelsController extends Controller {
  readonly #router: Router;

  constructor(router: Router) {
    super();
    this.#router = router;
  }

  handle() {
    return this.view('dashboard/Panels', {
      panels: [
        { key: 'sign_ins', url: this.#router.url('dashboard.sign-ins', {}, { limit: 3 }) },
        { key: 'members', url: this.#router.url('dashboard.members') },
      ],
    });
  }
}
