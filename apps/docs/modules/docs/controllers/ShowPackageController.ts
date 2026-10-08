import { Controller, type HttpContext } from '@marmeon/http';
import { DocsRepository, type DocPage } from '../DocsRepository.ts';

/** What `docs/Page` shows of a page of the docs or a package's README: the page, and the pages before and after it in the navigation. */
export function pageProps(page: DocPage, docs: DocsRepository) {
  const { title, section, body, toc } = page;
  const { previous, next } = docs.neighbours(page);
  const link = (other: DocPage | null) => (other ? { path: other.path, title: other.title } : null);
  return { title, section, body, toc, previous: link(previous), next: link(next) };
}

/** `/packages/:name`: a package's README, its table of contents, and the pages before and after it. */
export class ShowPackageController extends Controller {
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    super();
    this.#docs = docs;
  }

  /** `name` is bound by the route (DocsRepository): an unknown package never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { name: DocPage }>) {
    return this.view('docs/Page', pageProps(ctx.params.name, this.#docs));
  }
}
