import { Controller } from '@marmeon/http';
import { DocsRepository } from '../DocsRepository.ts';

/** `/`: what Marmeon is, where to start, and every section of the docs with its pages (the package READMEs are not among them). */
export class ShowHomeController extends Controller {
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    super();
    this.#docs = docs;
  }

  handle() {
    const sections = this.#docs.sections().map(({ title, pages }) => ({ title, pages: pages.map(({ label, path }) => ({ label, path })) }));
    return this.view('docs/Home', { sections });
  }
}
