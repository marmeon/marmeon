/** One section of a page in the search index: what is under one heading. */
export interface IndexedSection {
  /** The page: `/docs/<slug>`. */
  readonly path: string;
  /** The page's title — `@marmeon/scheduler`. */
  readonly page: string;
  readonly heading: string;
  readonly anchor: string;
  readonly text: string;
  /** A record of changes (UPGRADING.md): after every other hit, whatever its score. */
  readonly late?: boolean;
}

/** A hit: where it is, and a piece of the text around the first match. */
export interface SearchResult {
  readonly href: string;
  readonly page: string;
  readonly heading: string;
  readonly excerpt: string;
}

/** At most this many words of a query count; a query is short anyway (the route's schema allows 100 characters). */
const MAX_TERMS = 8;
const EXCERPT_BEFORE = 60;
const EXCERPT_LENGTH = 200;

interface Entry extends IndexedSection {
  readonly lowerPage: string;
  readonly lowerHeading: string;
  readonly lowerText: string;
  readonly order: number;
}

/**
 * The search over every section of every page — in memory, built with the pages (E133: a server route, no index in the
 * browser). Words are matched as parts of words, case-insensitively, all of them in one section; a match in the page's name
 * weighs most, then the heading, then how often the text has it — and a record of changes comes last.
 */
export class SearchIndex {
  readonly #entries: Entry[];

  constructor(sections: readonly IndexedSection[]) {
    this.#entries = sections.map((section, order) => ({
      ...section,
      lowerPage: section.page.toLowerCase(),
      lowerHeading: section.heading.toLowerCase(),
      lowerText: section.text.toLowerCase(),
      order,
    }));
  }

  get size(): number {
    return this.#entries.length;
  }

  search(query: string, { limit = 20 }: { limit?: number } = {}): SearchResult[] {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
    if (terms.length === 0) return [];
    const hits: { entry: Entry; score: number }[] = [];
    for (const entry of this.#entries) {
      let score = 0;
      let all = true;
      for (const term of terms) {
        const inPage = entry.lowerPage.includes(term);
        const inHeading = entry.lowerHeading.includes(term);
        const inText = occurrences(entry.lowerText, term, 5);
        if (!inPage && !inHeading && inText === 0) {
          all = false;
          break;
        }
        score += (inPage ? 8 : 0) + (inHeading ? 5 : 0) + inText;
      }
      if (all) hits.push({ entry, score });
    }
    hits.sort((a, b) => Number(a.entry.late ?? false) - Number(b.entry.late ?? false) || b.score - a.score || a.entry.order - b.entry.order);
    return hits.slice(0, limit).map(({ entry }) => ({
      href: entry.anchor ? `${entry.path}#${entry.anchor}` : entry.path,
      page: entry.page,
      heading: entry.heading,
      excerpt: excerpt(entry.text, entry.lowerText, terms),
    }));
  }
}

function occurrences(text: string, term: string, max: number): number {
  let count = 0;
  for (let at = text.indexOf(term); at !== -1 && count < max; at = text.indexOf(term, at + term.length)) count++;
  return count;
}

/** The text around the first match of any term (the start of the section without one), cut at word boundaries. */
function excerpt(text: string, lower: string, terms: readonly string[]): string {
  const first = Math.min(...terms.map((term) => lower.indexOf(term)).filter((at) => at !== -1));
  const from = Number.isFinite(first) ? Math.max(0, first - EXCERPT_BEFORE) : 0;
  let start = from === 0 ? 0 : text.indexOf(' ', from) + 1;
  if (start <= 0 || (Number.isFinite(first) && start > first)) start = from;
  let end = Math.min(text.length, start + EXCERPT_LENGTH);
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > start) end = space;
  }
  return `${start > 0 ? '… ' : ''}${text.slice(start, end)}${end < text.length ? ' …' : ''}`;
}
