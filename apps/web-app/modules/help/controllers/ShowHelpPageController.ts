import { abort, Controller, PageAlternates, type HttpContext, type SitemapEntries } from '@marmeon/http';
import { HelpPages } from '../HelpPages.ts';

/** The fallback below `/:locale/help`: the overview at `/en/help`, a page at its path in the language of the address, a 404 for a path the help does not have. */
export class ShowHelpPageController extends Controller {
  readonly #pages: HelpPages;
  readonly #alternates: PageAlternates;

  constructor(pages: HelpPages, alternates: PageAlternates) {
    super();
    this.#pages = pages;
    this.#alternates = alternates;
  }

  handle(ctx: HttpContext<{}, { locale: string; path: string }>) {
    const { locale, path } = ctx.params;
    const pages = this.#pages.all(locale).map(({ path, title }) => ({ path, title }));
    // The overview has one address in every language: the versions the framework derives are right.
    if (path === '') return this.view('help/Show', { page: null, pages });
    const page = this.#pages.find(locale, path);
    if (!page) {
      // The address without a language keeps the slug it was given, so a visitor can arrive on another language's slug: send them to this language's own.
      const other = this.#pages.findInAnyLanguage(path);
      const here = other && this.#pages.inLanguage(other, locale);
      return here ? this.redirect().route('help.page', { locale, path: here.path }).status(301) : abort(404);
    }
    // Each language names its own address; the address without a language keeps the slug it was given, which would be a 404 for a visitor of another language, so `x-default` names the English page.
    this.#alternates.replace({
      ...Object.fromEntries(Object.entries(this.#pages.versionsOf(page)).map(([language, version]) => [language, { path: version.path }])),
      'x-default': { locale: 'en', path: (this.#pages.inLanguage(page, 'en') ?? page).path },
    });
    return this.view('help/Show', { page, pages });
  }

  /** The pages of this route in /sitemap.xml: the overview once (listed in every language, as its head names them), every page per language with the versions it names itself. */
  sitemap(): SitemapEntries<{ locale?: string; path: string }> {
    const entries: { params: { locale?: string; path: string }; alternates?: Record<string, { locale: string; path: string }> }[] = [{ params: { path: '' } }];
    const add = (versions: Record<string, string>, standard: string) => {
      const alternates = {
        ...Object.fromEntries(Object.entries(versions).map(([locale, path]) => [locale, { locale, path }])),
        'x-default': { locale: 'en', path: standard },
      };
      for (const [locale, path] of Object.entries(versions)) entries.push({ params: { locale, path }, alternates });
    };
    for (const page of this.#pages.all('en')) {
      add(Object.fromEntries(Object.entries(this.#pages.versionsOf(page)).map(([locale, version]) => [locale, version.path])), page.path);
    }
    return entries;
  }
}
