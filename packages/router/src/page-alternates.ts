import { matchParams } from './pattern.ts';
import { fillPath, type Param } from './url.ts';

/** What `replace()` needs of the route that answers: its name and pattern, the request's query, and the locales a key may name. @internal */
export interface PageAlternatesSource {
  readonly name: string;
  readonly pattern: string;
  readonly search: string;
  readonly locales: readonly string[];
}

/**
 * The other-language versions of the page being answered — locale to path (`{ en: '/en/about', de: '/de/about' }`), set by
 * the locale middleware on a localized route from the same parameters in every language. A controller whose page has another
 * path per language names them with `replace()`, or says there are none with `none()`; the page's `<link rel="alternate">`s and a
 * language switcher follow. Scoped: one per request. See `docs/localization.md#translated-paths`.
 */
export class PageAlternates {
  #paths: Readonly<Record<string, string>> | undefined;
  #source: PageAlternatesSource | undefined;

  /** @internal */
  get paths(): Readonly<Record<string, string>> | undefined {
    return this.#paths;
  }

  /** `source` is the localized route that answers; without it `replace()` and `none()` have no route to build from. @internal */
  set(paths: Readonly<Record<string, string>> | undefined, source?: PageAlternatesSource): void {
    this.#paths = paths;
    this.#source = source;
  }

  /**
   * Names the versions of this page, each as the parameters of the answering route: the key is a supported locale or `x-default`
   * (a value with `locale` points `x-default` at that language's version, which a path that differs per language needs — the
   * address without a locale keeps the slug it was given). A language without an entry has no version. Replaces what the
   * framework derived. Throws a `TypeError` for an unknown key, parameters that name no page of the route, or a route that is
   * not localized.
   */
  replace(versions: Readonly<Record<string, Readonly<Record<string, Param>>>>): void {
    const source = this.#sourceOf('replace');
    const paths: Record<string, string> = {};
    for (const [key, params] of Object.entries(versions)) {
      if (typeof params !== 'object' || params === null) throw new TypeError(`PageAlternates.replace(): the value of [${key}] is no parameters object.`);
      const isDefault = key === 'x-default';
      // The address without a locale takes no `locale` unless the entry names one: then it is that language's version.
      const locale = isDefault ? params.locale : key;
      // Any key but `x-default` is its own locale: a value naming another one contradicts its key.
      if (!isDefault && params.locale !== undefined && params.locale !== key) throw new TypeError(`PageAlternates.replace(): the value of [${key}] names the locale ${String(params.locale)}; a language's version is in that language.`);
      if (locale !== undefined && (typeof locale !== 'string' || !source.locales.includes(locale))) {
        throw new TypeError(`PageAlternates.replace(): [${isDefault ? `x-default's locale ${String(locale)}` : key}] is not a supported locale (${source.locales.join(', ')})${isDefault ? '' : ' or x-default'}.`);
      }
      const pattern = locale === undefined ? source.pattern.replace(/^\/:locale/, '') || '/' : source.pattern;
      paths[key] = this.#build(source, pattern, { ...params, ...(locale === undefined ? {} : { locale }) }, key) + source.search;
    }
    this.#paths = Object.keys(paths).length > 0 ? paths : undefined;
  }

  /** Says the page has no other version: no `<link rel="alternate">`, and nothing for a language switcher to link. */
  none(): void {
    this.#sourceOf('none');
    this.#paths = undefined;
  }

  #sourceOf(method: string): PageAlternatesSource {
    if (this.#source === undefined) throw new TypeError(`PageAlternates.${method}() works on a page of a localized route.`);
    return this.#source;
  }

  /** The path of one version, built from the route's pattern — never from the request — and checked as the server matches a request. */
  #build(source: PageAlternatesSource, pattern: string, params: Record<string, Param>, key: string): string {
    let path: string;
    try {
      path = fillPath(source.name, pattern, params).path;
    } catch (error) {
      throw new TypeError(`PageAlternates.replace(): the parameters of [${key}] name no page of the route: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    // Decoded, so `..%2Fadmin` (a segment with a slash) and a value the constraint refuses are no page.
    if (!matchParams(pattern, decodeURIComponent(path))) throw new TypeError(`PageAlternates.replace(): the parameters of [${key}] name no page of the route [${source.name}].`);
    return path;
  }
}
