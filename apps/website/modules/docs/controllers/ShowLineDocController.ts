import { Controller, type HttpContext } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import { DocsRepository, type DocPage } from '../DocsRepository.ts';
import { lineNote, newestPath, type DocsLine } from '../DocsLines.ts';
import { markdownResponse } from '../markdown-response.ts';
import { prefersMarkdown } from '../negotiate.ts';

/**
 * `/docs/<line>/<page>`: a page of a release line, from the line's snapshot only. The newest version of the page (or the start of
 * the docs, when the page is gone) is the canonical one, and the line is not indexed.
 */
export class ShowLineDocController extends Controller {
  readonly #docs: DocsRepository;
  readonly #app: AppConfig;

  constructor(docs: DocsRepository, app: AppConfig) {
    super();
    this.#docs = docs;
    this.#app = app;
  }

  /** `line` and `page` are bound by the route (LineBinding, LinePageBinding): an unknown one never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { line: DocsLine; page: DocPage }>) {
    const { line, page } = ctx.params;
    const newest = newestPath(this.#docs, page);
    if (prefersMarkdown(ctx.request)) {
      const url = publicUrl(this.#app, newest);
      return markdownResponse(lineNote(line, url, newest !== '/docs') + page.markdown, url, { 'content-location': `${page.path}.md` });
    }
    const { previous, next } = line.repository.neighbours(page);
    const link = (other: DocPage | null) => (other ? { path: other.path, title: other.title, section: other.section } : null);
    return this.view('docs/LinePage', {
      title: page.title,
      section: page.section,
      body: page.body,
      toc: page.toc,
      description: page.description,
      path: page.path,
      newest,
      markdown: `${page.path}.md`,
      line: { name: line.name, version: line.version },
      lineNav: line.repository.navigation(),
      previous: link(previous),
      next: link(next),
    });
  }
}
