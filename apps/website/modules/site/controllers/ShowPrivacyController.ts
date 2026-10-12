import { Controller } from '@marmeon/http';
import { DESCRIPTIONS } from '../descriptions.ts';
import { LegalPages } from '../LegalPages.ts';

/** `/privacy`: the privacy policy (`content/legal/privacy.md`). */
export class ShowPrivacyController extends Controller {
  readonly #legal: LegalPages;

  constructor(legal: LegalPages) {
    super();
    this.#legal = legal;
  }

  handle() {
    const { title, body } = this.#legal.page('privacy');
    return this.view('site/Legal', { title, body, description: DESCRIPTIONS.privacy, path: '/privacy' });
  }
}
