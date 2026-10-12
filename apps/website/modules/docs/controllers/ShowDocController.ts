import { Controller, type HttpContext } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import { DocsRepository, type DocPage } from '../DocsRepository.ts';
import { markdownResponse } from '../markdown-response.ts';
import { prefersMarkdown } from '../negotiate.ts';

/**
 * `/docs/:page`: a page of the docs (`docs/<slug>.md`, `UPGRADING.md`, …), its table of contents, and the pages before and after it.
 * A client that asks for Markdown gets the page's Markdown instead (docs/<slug>.md).
 */
export class ShowDocController extends Controller {
  readonly #docs: DocsRepository;
  readonly #app: AppConfig;

  constructor(docs: DocsRepository, app: AppConfig) {
    super();
    this.#docs = docs;
    this.#app = app;
  }

  /** `page` is bound by the route (DocBinding): an unknown page never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { page: DocPage }>) {
    const { title, section, body, toc, path, markdown, description } = ctx.params.page;
    if (prefersMarkdown(ctx.request)) return markdownResponse(markdown, publicUrl(this.#app, path), { 'content-location': `${path}.md` });
    const { previous, next } = this.#docs.neighbours(ctx.params.page);
    const link = (other: DocPage | null) => (other ? { path: other.path, title: other.title, section: other.section } : null);
    return this.view('docs/Page', { title, section, body, toc, description, path, markdown: `${path}.md`, previous: link(previous), next: link(next) });
  }
}
