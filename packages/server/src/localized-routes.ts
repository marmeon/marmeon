import type { Router } from '@marmeon/router';
import type { UrlLocales } from '@marmeon/router/internal';
import { withCode } from '@marmeon/core/internal';
import { withoutLocale } from '@marmeon/router/internal';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The Hono path of a localized route: its `/:locale` limited to the locales of the app, in their spelling (`/:locale{en|de|de-AT}`). */
export function localizedPath(path: string, supported: readonly string[]): string {
  return path.replace(/^\/:locale/, `/:locale{${supported.map(escapeRegExp).join('|')}}`);
}

// The lookbehind starts a match only at the first slash of a run: linear on a long run that does not reach the end.
const trimmed = (path: string): string => (path.length > 1 ? path.replace(/(?<!\/)\/+$/, '') : path);

/**
 * Refuses the start when the localized routes cannot work: no locales are bound, a route without `localized()` sits under the
 * first segment a locale owns, or the route without its locale (which redirects) is taken by a route of the app. With a locale
 * without a prefix the address of that locale is the route itself, so the same holds for it, for any method the two share, and
 * the locale has to be one the app supports. `path` masks secrets in the paths the message names.
 */
export function checkLocalizedRoutes(router: Router, urlLocales: UrlLocales | undefined, path: (route: { path: string }) => string = (route) => route.path): void {
  // Before the early return: an app without a localized route reads the locale too (the router registers by it), and must stop with a code, not an error.
  const unprefixed = urlLocales?.unprefixed;
  if (urlLocales && unprefixed !== undefined && !urlLocales.supported.includes(unprefixed)) {
    throw new Error(withCode('H9', `The default locale without a prefix [${unprefixed}] is none of the supported ones (${urlLocales.supported.join(', ') || 'none'}): its pages would have no address. Give it the spelling of one of them. See docs/routing.md#routes-under-a-locale.`));
  }
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
  // The address of the locale without a prefix is a literal segment of the route: `/en/x` would be that locale's own path, which the address never answers.
  if (unprefixed !== undefined) {
    for (const route of localized) {
      const segment = withoutLocale(route.path).split('/')[1] ?? '';
      if (segment !== '' && !segment.startsWith(':') && owned.has(segment.toLowerCase())) {
        throw new Error(withCode('H9', `${route.methods.join('|')} ${path(route)} (Route.localized()) starts with the locale [${segment}] after its prefix: the address of the default locale without a prefix, ${path({ path: withoutLocale(route.path) })}, would be the path of the locale [${segment}], which that locale's own address serves. Give the route another first segment. See docs/routing.md#routes-under-a-locale.`));
      }
    }
  }
  // The address without a locale of a localized fallback sits among the fallbacks and is asked before the localized one when its first
  // segment is literal: `/en/:path*` would take `/en/x` and send it to the visitor's language, so the locale `en` would be lost.
  for (const variant of router.fallbacks) {
    const source = variant.generatedFrom;
    const segment = variant.path.split('/')[1] ?? '';
    if (source && owned.has(segment.toLowerCase())) {
      throw new Error(withCode('H9', `GET ${path(source)} (Route.localized().fallback()) answers the address without a locale ${path(variant)}, which starts with [${segment}], a locale of the app: the visitor's language would take the address before the fallback, so pages in [${segment}] would be redirected away. Give the fallback another prefix. See docs/routing.md#routes-under-a-locale.`));
    }
  }
  const taken = router.registrationOrder.filter((route) => !route.generatedFrom);
  if (unprefixed !== undefined) {
    // HEAD is answered by the GET route: the two count as one method.
    const methodsOf = (route: { methods: readonly string[] }) => new Set(route.methods.map((method) => (method === 'HEAD' ? 'GET' : method)));
    for (const address of router.registrationOrder) {
      const source = address.generatedFrom;
      if (!source) continue;
      const mine = methodsOf(address);
      for (const other of taken) {
        // Route paths are stored without a trailing slash (`/about/` is `/about`), so the strings compare as they are.
        if (other.path !== address.path) continue;
        const shared = [...methodsOf(other)].filter((method) => mine.has(method));
        if (shared.length === 0) continue;
        throw new Error(withCode('H9', `${other.methods.join('|')} ${path(other)} and ${source.methods.join('|')} ${path(source)} (Route.localized()) both answer ${shared.join('|')} ${path(address)}: the address of the default locale without a prefix [${unprefixed}] is that route's. Give ${path(other)} another path, or register it through Route.localized(). See docs/routing.md#routes-under-a-locale.`));
      }
    }
    return;
  }
  for (const variant of router.registrationOrder) {
    const source = variant.generatedFrom;
    if (!source) continue;
    const other = taken.find((route) => route !== source && route.methods.includes('GET') && trimmed(route.path) === trimmed(variant.path));
    if (other) {
      throw new Error(withCode('H9', `GET ${path(other)} and GET ${path(source)} (Route.localized()) both answer GET ${path(variant)}: the URL without a locale redirects to the visitor's language. Give ${path(other)} another path, or register it through Route.localized(). See docs/routing.md#routes-under-a-locale.`));
    }
  }
}
