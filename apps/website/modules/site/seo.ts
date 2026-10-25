/**
 * Everything may be crawled but the search: an endless URL space of thin pages behind a rate limit. `$` and `?` close the rule
 * exactly — a plain prefix would also shut out a future page whose slug starts with `search`.
 */
export function robotsTxt(sitemapUrl: string): string {
  return `User-agent: *\nDisallow: /docs/search$\nDisallow: /docs/search?\n\nSitemap: ${sitemapUrl}\n`;
}
