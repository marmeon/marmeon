import { Controller, type HttpContext } from '@bespokecore/http';
import { DocsRepository, type DocPage } from '../DocsRepository.ts';
import { pageProps } from './ShowPackageController.ts';

/** `/guides/:guide`: a guide (`docs/*.md`, `UPGRADING.md`, …), its table of contents, and the guides before and after it. */
export class ShowGuideController extends Controller {
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    super();
    this.#docs = docs;
  }

  /** `guide` is bound by the route (GuideBinding): an unknown guide never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { guide: DocPage }>) {
    return this.view('docs/Page', pageProps(ctx.params.guide, this.#docs));
  }
}
