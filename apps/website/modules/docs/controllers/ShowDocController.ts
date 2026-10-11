import { Controller, type HttpContext } from '@marmeon/http';
import { DocsRepository, type DocPage } from '../DocsRepository.ts';

/** `/docs/:page`: a page of the docs (`docs/<slug>.md`, `UPGRADING.md`, …), its table of contents, and the pages before and after it. */
export class ShowDocController extends Controller {
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    super();
    this.#docs = docs;
  }

  /** `page` is bound by the route (DocBinding): an unknown page never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { page: DocPage }>) {
    const { title, section, body, toc } = ctx.params.page;
    const { previous, next } = this.#docs.neighbours(ctx.params.page);
    const link = (other: DocPage | null) => (other ? { path: other.path, title: other.title, section: other.section } : null);
    return this.view('docs/Page', { title, section, body, toc, previous: link(previous), next: link(next) });
  }
}
