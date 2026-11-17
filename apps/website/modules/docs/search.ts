/** One section of a page in the search index: what is under one heading. */
export interface IndexedSection {
  /** The page: `/docs/<slug>`. */
  readonly path: string;
  /** The page's title — `Task Scheduling`. */
  readonly page: string;
  /** The section of the navigation the page is in — `The Basics`. */
  readonly section: string;
  readonly heading: string;
  readonly anchor: string;
  /** Its prose. */
  readonly text: string;
  /** Its code blocks. */
  readonly code: string;
  /** A record of changes (UPGRADING.md): after every other hit, whatever its score. */
  readonly late?: boolean;
}

/** A hit: where it is, and a piece of the text around the first match. */
export interface SearchResult {
  readonly href: string;
  readonly page: string;
  /** The navigation section of the page. */
  readonly section: string;
  readonly heading: string;
  readonly excerpt: string;
}

/** A page whose title holds every word of the query. */
export interface PageResult {
  /** `/docs/<slug>`. */
  readonly href: string;
  readonly page: string;
  /** The navigation section of the page. */
  readonly section: string;
}

/** What a search looks in: the pages' titles, the sections' text, or both. */
export const SEARCH_SCOPES = ['all', 'pages', 'sections'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/**
 * What the route answers: the pages by title and the sections by text — either list is empty when the scope leaves it out — and the
 * query and scope they answer, so the view can tell a list that is still the previous one's while the next answer is on its way.
 */
export interface SearchResults {
  readonly q: string;
  readonly scope: SearchScope;
  readonly pages: readonly PageResult[];
  readonly sections: readonly SearchResult[];
}

/** At most this many words of a query count; a query is short anyway (the route's schema allows 100 characters). */
const MAX_TERMS = 8;
const EXCERPT_BEFORE = 60;
const EXCERPT_LENGTH = 200;
/** What a section's code blocks add for a word they contain — however often: less than one mention in its prose. */
const CODE_WEIGHT = 0.5;

interface Entry extends IndexedSection {
  readonly lowerPage: string;
  readonly lowerHeading: string;
  readonly lowerText: string;
  readonly lowerCode: string;
  /** The heading's words, lower case: what the words of a name (`onOneServer`) are looked for in. */
  readonly headingWords: readonly string[];
  readonly order: number;
}

/** A word of the query: as typed, lower case, and the words of a name in it (`onOneServer` → on, one, server). */
interface Term {
  readonly lower: string;
  readonly words: readonly string[];
}

/**
 * The search over every section of every page — in memory, built with the pages (a server route, no index in the
 * browser). Words are matched as parts of words, case-insensitively, all of them in one section; a match in the page's name
 * weighs most, then the heading — also a heading with the words of a name (`onOneServer` → "One server only") — then how
 * often the prose has it, and last that a code block uses it: a section that explains a word comes before an example that
 * only calls it. A record of changes comes after every other hit. {@link SearchIndex.pages} looks in the pages' titles only: every word of the
 * query must be in the title.
 */
export class SearchIndex {
  readonly #entries: Entry[];

  constructor(sections: readonly IndexedSection[]) {
    this.#entries = sections.map((section, order) => ({
      ...section,
      lowerPage: section.page.toLowerCase(),
      lowerHeading: section.heading.toLowerCase(),
      lowerText: section.text.toLowerCase(),
      lowerCode: section.code.toLowerCase(),
      headingWords: section.heading.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
      order,
    }));
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * The pages whose title holds every word of the query, as parts of words and case-insensitively — one row per page, in the order
   * of the docs, the record of changes last; at most `limit` (6 by default). Only the first 8 words of the query count, as in
   * {@link SearchIndex.search}. A name (`onOneServer`) is one word here: titles hold plain words.
   */
  pages(query: string, { limit = 6 }: { limit?: number } = {}): PageResult[] {
    const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
    if (words.length === 0) return [];
    const seen = new Set<string>();
    const found: { page: PageResult; late: boolean }[] = [];
    for (const entry of this.#entries) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      if (words.every((word) => entry.lowerPage.includes(word))) found.push({ page: { href: entry.path, page: entry.page, section: entry.section }, late: entry.late ?? false });
    }
    return [...found.filter(({ late }) => !late), ...found.filter(({ late }) => late)].slice(0, limit).map(({ page }) => page);
  }

  search(query: string, { limit = 20 }: { limit?: number } = {}): SearchResult[] {
    const typed = [...new Map(query.split(/\s+/).filter(Boolean).map((word) => [word.toLowerCase(), word])).values()].slice(0, MAX_TERMS);
    if (typed.length === 0) return [];
    const terms: Term[] = typed.map((word) => ({ lower: word.toLowerCase(), words: wordsOf(word) }));
    const hits: { entry: Entry; score: number }[] = [];
    for (const entry of this.#entries) {
      let score = 0;
      let all = true;
      for (const { lower: term, words } of terms) {
        const inPage = entry.lowerPage.includes(term);
        const inText = occurrences(entry.lowerText, term, 5);
        const inCode = entry.lowerCode.includes(term);
        // A section that uses a name under a heading of its words — each word begins one of the heading's: `onOneServer` under
        // "One server only". The heading alone finds nothing: "One server with Compose" without the name is no hit.
        const named = (inText > 0 || inCode) && words.length > 1 && words.every((word) => entry.headingWords.some((heading) => heading.startsWith(word)));
        const inHeading = entry.lowerHeading.includes(term) || named;
        if (!inPage && !inHeading && inText === 0 && !inCode) {
          all = false;
          break;
        }
        // A code block that uses the word counts once, and less than a sentence that names it.
        score += (inPage ? 8 : 0) + (inHeading ? 5 : 0) + inText + (inCode ? CODE_WEIGHT : 0);
      }
      if (all) hits.push({ entry, score });
    }
    const lowers = terms.map((term) => term.lower);
    hits.sort((a, b) => Number(a.entry.late ?? false) - Number(b.entry.late ?? false) || b.score - a.score || a.entry.order - b.entry.order);
    return hits.slice(0, limit).map(({ entry }) => ({
      href: entry.anchor ? `${entry.path}#${entry.anchor}` : entry.path,
      page: entry.page,
      section: entry.section,
      heading: entry.heading,
      // From the prose when it has a word of the query; from the code when only the code has one.
      excerpt: lowers.some((term) => entry.lowerText.includes(term)) || !entry.code ? excerpt(entry.text, entry.lowerText, lowers) : excerpt(entry.code, entry.lowerCode, lowers),
    }));
  }
}

/** The words of a name: `onOneServer` → on, one, server; `queue:work`, `per_page` → their parts. One word gives none. */
function wordsOf(word: string): string[] {
  const words = word
    .split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|[^\p{L}\p{N}]+/u)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
  return words.length > 1 ? words : [];
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
