import { Controller, type HttpContext } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import { SiteInfo } from '../../site/SiteInfo.ts';
import { DocsLines } from '../DocsLines.ts';
import { DocsRepository } from '../DocsRepository.ts';
import { llmsHeader, llmsIndex, llmsSections, releaseLinesSection } from '../llms.ts';
import { markdownResponse } from '../markdown-response.ts';
import { prefersMarkdown } from '../negotiate.ts';

/**
 * `/docs`: what Marmeon is, where to start, and every section of the docs with its pages. A client that asks for Markdown gets
 * the index of `/llms.txt` instead.
 */
export class ShowHomeController extends Controller {
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

  handle(ctx: HttpContext) {
    if (prefersMarkdown(ctx.request)) {
      const url = (path: string) => publicUrl(this.#app, path);
      const header = llmsHeader({ version: this.#site.version, docsUrl: url('/docs'), fullUrl: url('/llms-full.txt') });
      return markdownResponse(llmsIndex(header, [...llmsSections(this.#docs, url), ...releaseLinesSection(this.#lines.all(), url)]), url('/docs'));
    }
    const sections = this.#docs.sections().map(({ title, pages }) => ({ title, pages: pages.map(({ label, path }) => ({ label, path })) }));
    const lines = this.#lines.all().map(({ name, version }) => ({ name, version, path: `/docs/${name}` }));
    return this.view('docs/Home', { sections, lines });
  }
}
