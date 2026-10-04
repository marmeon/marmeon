import { Controller } from '@bespokecore/http';
import { DocsRepository } from '../DocsRepository.ts';

/** `/`: the repository's README — what BespokeCore is, the principles, the quick start, the packages. */
export class ShowHomeController extends Controller {
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    super();
    this.#docs = docs;
  }

  handle() {
    const { title, body, toc } = this.#docs.home();
    return this.view('docs/Home', { title, body, toc });
  }
}
