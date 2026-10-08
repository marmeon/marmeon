import { Controller, type HttpContext } from '@marmeon/http';
import { DocsRepository, type DocPage } from '../DocsRepository.ts';
import { pageProps } from './ShowPackageController.ts';

/** `/docs/:page`: a page of the docs (`docs/<slug>.md`, `UPGRADING.md`, …), its table of contents, and the pages before and after it. */
export class ShowDocController extends Controller {
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    super();
    this.#docs = docs;
  }

  /** `page` is bound by the route (DocBinding): an unknown page never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { page: DocPage }>) {
    return this.view('docs/Page', pageProps(ctx.params.page, this.#docs));
  }
}
