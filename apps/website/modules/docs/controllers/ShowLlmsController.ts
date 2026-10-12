import { Controller } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import { SiteInfo } from '../../site/SiteInfo.ts';
import { textResponse } from '../../site/text-response.ts';
import { DocsRepository } from '../DocsRepository.ts';
import { llmsHeader, llmsIndex } from '../llms.ts';

/** `/llms.txt`: the docs' pages by section, each linked to its Markdown. Drafts are left out. */
export class ShowLlmsController extends Controller {
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
    const sections = this.#docs.sections().map((section) => ({
      title: section.title,
      pages: section.pages.flatMap((entry) => {
        const page = this.#docs.doc(entry.name);
        return page && !page.pending ? [{ title: page.title, url: publicUrl(this.#app, `${page.path}.md`) }] : [];
      }),
    }));
    return textResponse(llmsIndex(header, sections), 'text/plain; charset=utf-8');
  }
}
