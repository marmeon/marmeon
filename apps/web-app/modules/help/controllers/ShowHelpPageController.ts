import { abort, Controller, type HttpContext, type SitemapEntries } from '@marmeon/http';
import { HelpPages } from '../HelpPages.ts';

/** The fallback below `/:locale/help`: the overview at `/en/help`, a page at its path, a 404 for a path the help does not have. */
export class ShowHelpPageController extends Controller {
  readonly #pages: HelpPages;

  constructor(pages: HelpPages) {
    super();
    this.#pages = pages;
  }

  handle(ctx: HttpContext<{}, { locale: string; path: string }>) {
    const { locale, path } = ctx.params;
    const pages = this.#pages.all(locale).map(({ path, title }) => ({ path, title }));
    if (path === '') return this.view('help/Show', { page: null, pages });
    return this.view('help/Show', { page: this.#pages.find(locale, path) ?? abort(404), pages });
  }

  /** The pages of this route in /sitemap.xml, in each language: the overview and every page. */
  sitemap(): SitemapEntries<{ path: string }> {
    return [{ params: { path: '' } }, ...this.#pages.all('en').map(({ path }) => ({ params: { path } }))];
  }
}
