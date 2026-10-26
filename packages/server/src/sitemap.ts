import { Clock, type Container, type Logger } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { addsOf, fillPath, tokenizePattern } from '@marmeon/router/internal';
import type { Router, RouteDefinition } from '@marmeon/router';
import { matchesPath } from '@marmeon/router/url';
import type { SitemapEntries, SitemapEntry } from '@marmeon/router';

/** The most URLs one sitemap file may list (the protocol's limit); the rest is cut off with a warning. */
export const SITEMAP_LIMIT_URLS = 50_000;

/** How long `/sitemap.xml` answers with the file it made last: the endpoint is open, and an entry hook reads the database. */
export const SITEMAP_CACHE_MS = 300_000;

/** How long a failed run keeps the hook from being called again: requests in it get the last good file, or a 503. */
export const SITEMAP_FAILURE_MS = 30_000;

/** The sitemap and robots.txt, answered by the kernel behind the global middleware only (no session, no cookie). */
export interface SitemapEndpoints {
  sitemap(): Promise<Response>;
  robots(): Response;
}

/** Whether the path has parameters of its own: the `/:locale` of a localized route is the framework's, not the hook's. */
const hasParameters = (route: RouteDefinition): boolean => tokenizePattern(route.localized ? route.path.replace(/^\/:locale/, '') : route.path).some((token) => 'name' in token);

const hookOf = (route: RouteDefinition): boolean =>
  typeof (route.action as { prototype?: { sitemap?: unknown } }).prototype?.sitemap === 'function';

/**
 * The routes marked with `.sitemap()`, after the start checks only the loaded routes cannot make: `APP_URL` is the only source of
 * the host in a `<loc>` (never the request's `Host`), and no middleware of a group may sign a user in. `path` masks secrets in
 * the paths the message names.
 */
export function sitemapRoutes(router: Router, appUrl: string | undefined, path: (route: { path: string }) => string = (route) => route.path): readonly RouteDefinition[] {
  const marked = router.routes.filter((route) => route.inSitemap);
  if (marked.length === 0) return marked;
  const first = marked[0]!;
  if (!appUrl || !URL.canParse(appUrl) || !/^https?:$/.test(new URL(appUrl).protocol)) {
    throw new Error(withCode('H10', `sitemap() on ${first.methods.join('|')} ${path(first)} needs APP_URL, the address the sitemap writes into every <loc>: ${appUrl ? `[${appUrl}] is no http or https URL` : 'it is not set'}. See docs/seo.md#sitemap-and-robotstxt.`));
  }
  for (const route of marked) {
    if (router.middlewareFor(route).some((middleware) => addsOf(middleware).includes('user'))) {
      throw new TypeError(withCode('H10', `sitemap() on ${route.methods.join('|')} ${path(route)}: a sitemap lists pages anyone can open, and a middleware of this route's group adds the signed-in user. See docs/seo.md#sitemap-and-robotstxt.`));
    }
  }
  return marked;
}

/** `YYYY-MM-DD` of a date, in UTC; undefined for one that is no point in time. */
function day(date: Date | undefined): string | undefined {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (text: string): string => text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]!);

type Entries = SitemapEntries<Record<string, string | number>>;

/**
 * The sitemap and robots.txt of `routes`; their URLs begin with `appUrl`. A localized route is listed once per entry and locale
 * (`locales`, each in its URL spelling), every `<url>` naming all of its language versions and the address without a locale as
 * `x-default`.
 */
export function createSitemapEndpoints(routes: readonly RouteDefinition[], container: Container, { appUrl, locales = [], logger, report }: { appUrl: string; locales?: readonly string[]; logger: Pick<Logger, 'warn'>; report: (error: unknown) => void }): SitemapEndpoints {
  const clock = container.has(Clock) ? container.make(Clock) : { now: () => Date.now() };
  /** The routes already warned about, once each: the file is made every five minutes, a line each time would be noise. */
  const warned = new Set<RouteDefinition>();
  const warnOnce = (route: RouteDefinition, message: string): void => {
    if (warned.has(route)) return;
    warned.add(route);
    logger.warn(message);
  };
  let truncated = false;

  async function* entriesOf(route: RouteDefinition): AsyncGenerator<SitemapEntry<Record<string, string | number>>> {
    // Its own scope: a controller built for the sitemap shares nothing with a request.
    const scope = container.createScope();
    if (!hookOf(route)) {
      if (hasParameters(route)) return;
      yield { params: {} };
      return;
    }
    const controller = scope.make(route.action as unknown as new () => { sitemap(): Entries }) as { sitemap(): Entries };
    const entries = await controller.sitemap();
    if (hasParameters(route)) {
      yield* entries;
      return;
    }
    // A page without parameters is one entry; its hook only says when it changed.
    let latest: Date | undefined;
    for await (const entry of entries) {
      const date = entry?.lastModified;
      if (date instanceof Date && !Number.isNaN(date.getTime()) && (!latest || date > latest)) latest = date;
    }
    yield { params: {}, ...(latest ? { lastModified: latest } : {}) };
  }

  async function build(): Promise<string> {
    const lines: string[] = [];
    let count = 0;
    let localizedSeen = false;
    truncated = false;
    collect: for (const route of routes) {
      const name = route.routeName ?? route.path;
      for await (const entry of entriesOf(route)) {
        // A localized route's hook names the page, not its language: one `<url>` for each of the app's locales.
        const versions = route.localized ? locales : [undefined];
        let paths: string[];
        let unprefixed: string | undefined;
        try {
          paths = versions.map((locale) => {
            const path = fillPath(name, route.path, { ...(entry.params as Record<string, string | number>), ...(locale === undefined ? {} : { locale }) }).path;
            // Matched as the server matches a request: decoded, so `..%2Fadmin` (a segment with a slash) and a value the
            // constraint refuses are no page.
            if (!matchesPath(route.path, decodeURIComponent(path))) throw new Error('the path does not match the route');
            return path;
          });
          if (route.localized) unprefixed = fillPath(name, route.path.replace(/^\/:locale/, '') || '/', entry.params as Record<string, string | number>).path;
        } catch {
          warnOnce(route, `The sitemap entries of ${route.methods.join('|')} ${route.path} include parameters that name no page of the route (a missing one, a dot segment, one its constraint refuses); they are left out.`);
          continue;
        }
        // The limit counts URLs, each locale one: an entry that does not fit whole is left out, so no `<url>` names a version that is missing.
        if (count + paths.length > SITEMAP_LIMIT_URLS) {
          if (!truncated) logger.warn(withCode('H10', `The sitemap lists ${SITEMAP_LIMIT_URLS} URLs, the most one file may hold: the rest is left out. See docs/seo.md#sitemap-and-robotstxt.`));
          truncated = true;
          break collect;
        }
        const lastmod = day(entry.lastModified);
        const alternates = unprefixed === undefined ? '' : [...versions.map((locale, index) => [locale!, paths[index]!] as const), ['x-default', unprefixed] as const].map(([language, path]) => `<xhtml:link rel="alternate" hreflang="${escapeXml(language)}" href="${escapeXml(new URL(path, appUrl).href)}"/>`).join('');
        if (alternates) localizedSeen = true;
        for (const path of paths) {
          lines.push(`  <url><loc>${escapeXml(new URL(path, appUrl).href)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}${alternates}</url>`);
        }
        count += paths.length;
      }
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${localizedSeen ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}</urlset>\n`;
  }

  // Requests that come while the file is made share the run, and for five minutes afterwards its result. A run that fails is
  // reported once, and for SITEMAP_FAILURE_MS the hook is not called again: the last good file is served meanwhile, else a 503.
  let running: Promise<string | undefined> | undefined;
  let last: { xml: string; at: number } | undefined;
  let failedAt: number | undefined;
  const xml = (): string | undefined | Promise<string | undefined> => {
    const now = clock.now();
    if (last && now - last.at < SITEMAP_CACHE_MS) return last.xml;
    if (failedAt !== undefined && now - failedAt < SITEMAP_FAILURE_MS) return last?.xml;
    running ??= build()
      .then(
        (result) => {
          last = { xml: result, at: clock.now() };
          failedAt = undefined;
          return result;
        },
        (error: unknown) => {
          failedAt = clock.now();
          try {
            report(error);
          } catch {
            // Reporting must not change the answer.
          }
          return last?.xml;
        },
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const sitemapUrl = new URL('/sitemap.xml', appUrl).href;
  return {
    sitemap: async () => {
      const body = await xml();
      if (body === undefined) {
        const wait = Math.max(1, Math.ceil((SITEMAP_FAILURE_MS - (clock.now() - (failedAt ?? 0))) / 1000));
        return new Response('Service Unavailable', { status: 503, headers: { 'retry-after': String(wait), 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
      }
      return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': `public, max-age=${SITEMAP_CACHE_MS / 1000}` } });
    },
    robots: () =>
      new Response(`User-agent: *\nDisallow: /_marmeon/\n\nSitemap: ${sitemapUrl}\n`, {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': `public, max-age=${SITEMAP_CACHE_MS / 1000}` },
      }),
  };
}
