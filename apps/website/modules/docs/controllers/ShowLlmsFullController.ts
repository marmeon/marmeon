import { Controller } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import { SiteInfo } from '../../site/SiteInfo.ts';
import { textResponse } from '../../site/text-response.ts';
import { DocsRepository } from '../DocsRepository.ts';
import { llmsFull, llmsHeader } from '../llms.ts';

/** `/llms-full.txt`: every page's Markdown in one file, links absolute. Drafts are left out. */
export class ShowLlmsFullController extends Controller {
  readonly #docs: DocsRepository;
  readonly #app: AppConfig;
  readonly #site: SiteInfo;

  constructor(docs: DocsRepository, app: AppConfig, site: SiteInfo) {
    super();
    this.#docs = docs;
    this.#app = app;
    this.#site = site;
  }

  handle() {
    const header = llmsHeader({ version: this.#site.version, docsUrl: publicUrl(this.#app, '/docs'), fullUrl: publicUrl(this.#app, '/llms-full.txt') });
    const pages = this.#docs
      .markdownPages((path) => publicUrl(this.#app, path), this.#app.url)
      .filter(({ page }) => !page.pending)
      .map(({ page, markdown }) => ({ url: publicUrl(this.#app, `${page.path}.md`), markdown }));
    return textResponse(llmsFull(header, pages), 'text/plain; charset=utf-8');
  }
}
