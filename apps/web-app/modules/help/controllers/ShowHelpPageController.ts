import { abort, Controller, type HttpContext, type SitemapEntries } from '@marmeon/http';
import { HelpPages } from '../HelpPages.ts';

/** The fallback below `/help`: the overview at `/help`, a page at its path, a 404 for a path the help does not have. */
export class ShowHelpPageController extends Controller {
  readonly #pages: HelpPages;

  constructor(pages: HelpPages) {
    super();
    this.#pages = pages;
  }

  handle(ctx: HttpContext<{}, { path: string }>) {
    const pages = this.#pages.all().map(({ path, title }) => ({ path, title }));
    if (ctx.params.path === '') return this.view('help/Show', { page: null, pages });
    return this.view('help/Show', { page: this.#pages.find(ctx.params.path) ?? abort(404), pages });
  }

  /** The pages of this route in /sitemap.xml: the overview and every page. */
  sitemap(): SitemapEntries<{ path: string }> {
    return [{ params: { path: '' } }, ...this.#pages.all().map(({ path }) => ({ params: { path } }))];
  }
}
