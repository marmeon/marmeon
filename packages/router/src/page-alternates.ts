/**
 * The other-language addresses of the page being answered — locale to path (`{ en: '/en/about', de: '/de/about' }`), set by
 * the locale middleware on a localized route and read by the page's renderer. Scoped: one per request.
 * @internal
 */
export class PageAlternates {
  #paths: Readonly<Record<string, string>> | undefined;

  get paths(): Readonly<Record<string, string>> | undefined {
    return this.#paths;
  }

  set(paths: Readonly<Record<string, string>>): void {
    this.#paths = paths;
  }
}
