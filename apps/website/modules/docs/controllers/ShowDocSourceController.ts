import { Controller, type HttpContext } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import { textResponse } from '../../site/text-response.ts';
import type { DocPage } from '../DocsRepository.ts';

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
    return textResponse(page.markdown, 'text/markdown; charset=utf-8', { link: `<${publicUrl(this.#app, page.path)}>; rel="canonical"` });
  }
}
