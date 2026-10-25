import type { Router } from '@marmeon/router';
import type { UrlLocales } from '@marmeon/router/internal';
import { withCode } from '@marmeon/core/internal';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The Hono path of a localized route: its `/:locale` limited to the locales of the app, in their spelling (`/:locale{en|de|de-AT}`). */
export function localizedPath(path: string, supported: readonly string[]): string {
  return path.replace(/^\/:locale/, `/:locale{${supported.map(escapeRegExp).join('|')}}`);
}

const trimmed = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/**
 * Refuses the start when the localized routes cannot work: no locales are bound, a route without `localized()` sits under the
 * first segment a locale owns, or the route without its locale (which redirects) is taken by a route of the app. `path`
 * masks secrets in the paths the message names.
 */
export function checkLocalizedRoutes(router: Router, urlLocales: UrlLocales | undefined, path: (route: { path: string }) => string = (route) => route.path): void {
  const localized = router.routes.filter((route) => route.localized);
  if (localized.length === 0) return;
  const first = localized[0]!;
  if (!urlLocales) {
    throw new Error(withCode('H9', `Route.localized() needs @marmeon/i18n: ${first.methods.join('|')} ${path(first)} lives under a locale, but no locales are bound. Register I18nServiceProvider. See docs/routing.md#routes-under-a-locale.`));
  }
  // The constraint is built from these: a name with a `/` or a regular expression would break the segments, none would match nothing.
  const spelling = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;
  const bad = urlLocales.supported.find((locale) => !spelling.test(locale));
  if (urlLocales.supported.length === 0 || bad !== undefined) {
    throw new Error(withCode('H9', `Route.localized() needs locales it can write into a URL: ${urlLocales.supported.length === 0 ? 'none are supported' : `[${bad}] is not letters and digits joined by hyphens`}. See docs/routing.md#routes-under-a-locale.`));
  }
  const owned = new Set(urlLocales.supported.map((locale) => locale.toLowerCase()));
  for (const route of router.routes) {
    if (route.localized) continue;
    const segment = route.path.split('/')[1] ?? '';
    if (owned.has(segment.toLowerCase())) {
      throw new Error(withCode('H9', `${route.methods.join('|')} ${path(route)} starts with the locale [${segment}], which ${first.methods.join('|')} ${path(first)} (Route.localized()) serves: the URL would have two owners. Register it through Route.localized(), or give it another path. See docs/routing.md#routes-under-a-locale.`));
    }
  }
  const taken = router.registrationOrder.filter((route) => !route.generatedFrom);
  for (const variant of router.registrationOrder) {
    const source = variant.generatedFrom;
    if (!source) continue;
    const other = taken.find((route) => route !== source && route.methods.includes('GET') && trimmed(route.path) === trimmed(variant.path));
    if (other) {
      throw new Error(withCode('H9', `GET ${path(other)} and GET ${path(source)} (Route.localized()) both answer GET ${path(variant)}: the URL without a locale redirects to the visitor's language. Give ${path(other)} another path, or register it through Route.localized(). See docs/routing.md#routes-under-a-locale.`));
    }
  }
}
