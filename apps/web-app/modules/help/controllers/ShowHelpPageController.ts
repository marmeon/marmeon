import { abort, Controller, type HttpContext } from '@marmeon/http';
import { HelpPages } from '../HelpPages.ts';

/** `/help/:path*`: the overview at `/help`, a page at its path, a 404 for a path the help does not have. */
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
}
