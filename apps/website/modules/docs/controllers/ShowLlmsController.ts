import { Controller } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import { SiteInfo } from '../../site/SiteInfo.ts';
import { textResponse } from '../../site/text-response.ts';
import { DocsLines } from '../DocsLines.ts';
import { DocsRepository } from '../DocsRepository.ts';
import { llmsHeader, llmsIndex, llmsSections, releaseLinesSection } from '../llms.ts';

/** `/llms.txt`: the docs' pages by section, each linked to its Markdown, then the release lines. Drafts are left out. */
export class ShowLlmsController extends Controller {
  readonly #docs: DocsRepository;
  readonly #lines: DocsLines;
  readonly #app: AppConfig;
  readonly #site: SiteInfo;

  constructor(docs: DocsRepository, lines: DocsLines, app: AppConfig, site: SiteInfo) {
    super();
    this.#docs = docs;
    this.#lines = lines;
    this.#app = app;
    this.#site = site;
  }

  handle() {
    const header = llmsHeader({ version: this.#site.version, docsUrl: publicUrl(this.#app, '/docs'), fullUrl: publicUrl(this.#app, '/llms-full.txt') });
    const url = (path: string) => publicUrl(this.#app, path);
    return textResponse(llmsIndex(header, [...llmsSections(this.#docs, url), ...releaseLinesSection(this.#lines.all(), url)]), 'text/plain; charset=utf-8');
  }
}
