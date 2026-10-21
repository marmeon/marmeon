import { Controller, type HttpContext } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import type { DocsLine } from '../DocsLines.ts';
import { llmsHeader, llmsIndex, llmsSections } from '../llms.ts';
import { textResponse } from '../../site/text-response.ts';

/** `/docs/<line>/llms.txt`: the line's pages by section, each linked to its Markdown under `/docs/<line>/`. Drafts are left out. */
export class ShowLineLlmsController extends Controller {
  readonly #app: AppConfig;

  constructor(app: AppConfig) {
    super();
    this.#app = app;
  }

  /** `line` is bound by the route (LineBinding): an unknown line never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { line: DocsLine }>) {
    const { name, version, repository } = ctx.params.line;
    const url = (path: string) => publicUrl(this.#app, path);
    const header = llmsHeader({ version, docsUrl: url(`/docs/${name}`), fullUrl: url(`/docs/${name}/llms-full.txt`), line: { name, newestUrl: url('/llms.txt') } });
    return textResponse(llmsIndex(header, llmsSections(repository, url)), 'text/plain; charset=utf-8', { link: `<${url('/llms.txt')}>; rel="canonical"` });
  }
}
