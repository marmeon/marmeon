import { Controller } from '@marmeon/http';
import { PACKAGES } from '../packages.ts';
import { SiteSnippets } from '../SiteSnippets.ts';

/** `/`: the landing page, with its code already highlighted and the list of packages (the page stays publicly cacheable). Both stay on the server: the client bundle only gets them as props. */
export class ShowLandingController extends Controller {
  readonly #snippets: SiteSnippets;

  constructor(snippets: SiteSnippets) {
    super();
    this.#snippets = snippets;
  }

  handle() {
    return this.view('site/Landing', { snippets: this.#snippets.all(), chain: this.#snippets.chain(), packages: PACKAGES });
  }
}
