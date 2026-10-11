import type { SearchResult } from './search.ts';

/** One page's hits on the search page. */
export interface PageHits {
  readonly page: string;
  /** The page's path, without an anchor. */
  readonly href: string;
  /** The navigation section the page is in. */
  readonly section: string;
  readonly hits: readonly { readonly heading: string; readonly href: string; readonly excerpt: string }[];
}

/** Groups a relevance-ordered list by page, in the order of each page's first hit. */
export function groupByPage(results: readonly SearchResult[]): PageHits[] {
  const groups = new Map<string, { page: string; href: string; section: string; hits: PageHits['hits'][number][] }>();
  for (const { href, page, section, heading, excerpt } of results) {
    const path = href.split('#')[0]!;
    let group = groups.get(path);
    if (!group) {
      group = { page, href: path, section, hits: [] };
      groups.set(path, group);
    }
    group.hits.push({ heading: heading || page, href, excerpt });
  }
  return [...groups.values()];
}
