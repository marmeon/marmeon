/** The paths of the sitemap: the landing and the docs' start page, every written page of the docs, then the legal pages. Drafts are left out. */
export function sitemapPaths(pages: readonly { path: string; pending: boolean }[]): string[] {
  return ['/', '/docs', ...pages.filter((page) => !page.pending).map((page) => page.path), '/imprint', '/privacy'];
}

/** The sitemap of `urls`. No `lastmod`: the image has no history, and a wrong date does more harm than none. */
export function sitemapXml(urls: readonly string[]): string {
  const entries = urls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>\n`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}</urlset>\n`;
}

// A broken sitemap is ignored without a word, so escape even what the slug rule and the APP_URL check already keep clean.
const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Everything may be crawled but the search: an endless URL space of thin pages behind a rate limit. `$` and `?` close the rule
 * exactly — a plain prefix would also shut out a future page whose slug starts with `search`.
 */
export function robotsTxt(sitemapUrl: string): string {
  return `User-agent: *\nDisallow: /docs/search$\nDisallow: /docs/search?\n\nSitemap: ${sitemapUrl}\n`;
}
