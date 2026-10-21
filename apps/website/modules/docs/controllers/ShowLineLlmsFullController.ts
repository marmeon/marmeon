import { Controller, type HttpContext } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import { textResponse } from '../../site/text-response.ts';
import type { DocsLine } from '../DocsLines.ts';
import { llmsFull, llmsHeader } from '../llms.ts';

/** `/docs/<line>/llms-full.txt`: every page of the line in one file, links absolute and under `/docs/<line>/`. Drafts are left out. */
export class ShowLineLlmsFullController extends Controller {
  readonly #app: AppConfig;

  constructor(app: AppConfig) {
    super();
    this.#app = app;
  }

  /** `line` is bound by the route (LineBinding): an unknown line never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { line: DocsLine }>) {
    const { name, version, repository } = ctx.params.line;
    const url = (path: string) => publicUrl(this.#app, path);
    const header = llmsHeader({ version, docsUrl: url(`/docs/${name}`), fullUrl: url(`/docs/${name}/llms-full.txt`), line: { name, newestUrl: url('/llms-full.txt') } });
    const pages = repository
      .markdownPages(url, this.#app.url)
      .filter(({ page }) => !page.pending)
      .map(({ page, markdown }) => ({ url: url(`${page.path}.md`), markdown }));
    return textResponse(llmsFull(header, pages), 'text/plain; charset=utf-8', { link: `<${url('/llms-full.txt')}>; rel="canonical"` });
  }
}
