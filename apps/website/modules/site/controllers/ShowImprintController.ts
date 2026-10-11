import { Controller } from '@marmeon/http';
import { LegalPages } from '../LegalPages.ts';

/** `/imprint`: the site notice (`content/legal/imprint.md`). */
export class ShowImprintController extends Controller {
  readonly #legal: LegalPages;

  constructor(legal: LegalPages) {
    super();
    this.#legal = legal;
  }

  handle() {
    const { title, body } = this.#legal.page('imprint');
    return this.view('site/Legal', { title, body });
  }
}
