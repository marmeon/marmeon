import { Controller, type HttpContext } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../../site/public-url.ts';
import type { DocsLine } from '../DocsLines.ts';
import { llmsHeader, llmsIndex, llmsSections } from '../llms.ts';
import { markdownResponse } from '../markdown-response.ts';
import { prefersMarkdown } from '../negotiate.ts';

/**
 * `/docs/<line>`: the sections of a release line's docs. A client that asks for Markdown gets the line's `llms.txt` instead.
 * Not indexed; the newest docs are named as the canonical ones.
 */
export class ShowLineHomeController extends Controller {
  readonly #app: AppConfig;

  constructor(app: AppConfig) {
    super();
    this.#app = app;
  }

  /** `line` is bound by the route (LineBinding): an unknown line never gets here — it is a 404. */
  handle(ctx: HttpContext<{}, { line: DocsLine }>) {
    const { name, version, repository } = ctx.params.line;
    if (prefersMarkdown(ctx.request)) {
      const url = (path: string) => publicUrl(this.#app, path);
      const header = llmsHeader({ version, docsUrl: url(`/docs/${name}`), fullUrl: url(`/docs/${name}/llms-full.txt`), line: { name, newestUrl: url('/docs') } });
      return markdownResponse(llmsIndex(header, llmsSections(repository, url)), url('/docs'));
    }
    const sections = repository.sections().map(({ title, pages }) => ({ title, pages: pages.map(({ label, path }) => ({ label, path })) }));
    return this.view('docs/LineHome', { line: { name, version }, sections });
  }
}
