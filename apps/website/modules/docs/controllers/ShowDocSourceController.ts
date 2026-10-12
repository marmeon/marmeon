import { Controller, type HttpContext } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import type { DocPage } from '../DocsRepository.ts';
import { markdownResponse } from '../markdown-response.ts';

/** `/docs/:file` (`routing.md`): a page's Markdown, with the HTML page named as the canonical one. */
export class ShowDocSourceController extends Controller {
  readonly #app: AppConfig;

  constructor(app: AppConfig) {
    super();
    this.#app = app;
  }

  /** `file` is bound by the route (DocSourceBinding): an unknown page never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { file: DocPage }>) {
    const page = ctx.params.file;
    return markdownResponse(page.markdown, publicUrl(this.#app, page.path));
  }
}
