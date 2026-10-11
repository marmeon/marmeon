import { Controller } from '@marmeon/http';
import { SiteSnippets } from '../SiteSnippets.ts';

/** `/`: the landing page, with its code already highlighted (the page stays publicly cacheable). */
export class ShowLandingController extends Controller {
  readonly #snippets: SiteSnippets;

  constructor(snippets: SiteSnippets) {
    super();
    this.#snippets = snippets;
  }

  handle() {
    return this.view('site/Landing', { snippets: this.#snippets.all() });
  }
}
