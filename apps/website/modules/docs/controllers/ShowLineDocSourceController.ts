import { Controller, type HttpContext } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import { DocsRepository, type DocPage } from '../DocsRepository.ts';
import { lineNote, newestPath, type DocsLine } from '../DocsLines.ts';
import { markdownResponse } from '../markdown-response.ts';

/** `/docs/<line>/<page>.md`: a release line's page as Markdown, with the newest version of the page as the canonical one. */
export class ShowLineDocSourceController extends Controller {
  readonly #docs: DocsRepository;
  readonly #app: AppConfig;

  constructor(docs: DocsRepository, app: AppConfig) {
    super();
    this.#docs = docs;
    this.#app = app;
  }

  /** `line` and `file` are bound by the route: an unknown one never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { line: DocsLine; file: DocPage }>) {
    const { line, file: page } = ctx.params;
    const newest = newestPath(this.#docs, page);
    const url = publicUrl(this.#app, newest);
    return markdownResponse(lineNote(line, url, newest !== '/docs') + page.markdown, url);
  }
}
