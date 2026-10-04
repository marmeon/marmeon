import { Controller, type HttpContext } from '@bespokecore/http';
import { DocsRepository, type DocPage } from '../DocsRepository.ts';

/** `/packages/:name`: a package's README, its table of contents, and the pages before and after it. */
export class ShowPackageController extends Controller {
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    super();
    this.#docs = docs;
  }

  /** `name` is bound by the route (DocsRepository): an unknown package never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { name: DocPage }>) {
    const { name, title, group, body, toc } = ctx.params.name;
    const { previous, next } = this.#docs.neighbours(name!);
    const link = (page: DocPage | null) => (page ? { name: page.name!, title: page.title } : null);
    return this.view('docs/Package', { name: name!, title, group, body, toc, previous: link(previous), next: link(next) });
  }
}
