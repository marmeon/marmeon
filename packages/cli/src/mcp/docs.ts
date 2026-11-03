import { dirname } from 'node:path';
import { headingsOf } from '../anchors.ts';
import { DocsLocation, readIndex, suggest, type DocsIndex, type Page } from '../commands/docs.ts';
import { readRegularIn } from '../files.ts';
import { DATA_NOTICE, failure, type ToolDocument, type ToolFailure } from './result.ts';
import type { McpTool } from './tools.ts';

const DEFAULT_LIMIT = 8;
const MAX_TERMS = 8;
const MAX_TERM_POINTS = 5;
const MAX_SNIPPET = 300;
/** The most that is read of one page; a page is a few dozen KiB. */
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_TEXT_CHARACTERS = 60_000;
const MAX_LISTED_ANCHORS = 60;

/** A part of a page that starts at a `##` or `###` heading (the part before the first one has no heading). */
export interface PageSection {
  /** The heading's words without markup; null for the part before the first heading. */
  readonly heading: string | null;
  readonly anchor: string | null;
  /** 2 or 3; 1 for the part before the first heading. */
  readonly level: number;
  /** The section as written, heading line first, up to the next `##` or `###` heading. */
  readonly text: string;
  /** The section with its subsections: up to the next heading of the same rank or a higher one. */
  readonly whole: string;
}

/** Splits a page at its `##` and `###` headings. A line inside a code block is never a heading. Every heading takes an anchor, as on the website. */
export function sectionsOf(markdown: string): PageSection[] {
  const lines = markdown.split('\n');
  const starts: { line: number; level: number; heading: string | null; anchor: string | null }[] = [{ line: 0, level: 1, heading: null, anchor: null }];
  for (const heading of headingsOf(markdown)) {
    if (heading.level === 2 || heading.level === 3) starts.push({ line: heading.line, level: heading.level, heading: heading.text, anchor: heading.anchor });
  }
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.line : lines.length;
    const next = starts.findIndex((other, j) => j > i && other.level <= start.level);
    const wholeEnd = next === -1 ? lines.length : starts[next]!.line;
    return { ...start, text: lines.slice(start.line, end).join('\n'), whole: lines.slice(start.line, wholeEnd).join('\n') };
  });
}

interface Loaded {
  readonly index: DocsIndex;
  readonly packageRoot: string;
}

function load(directory: string): Loaded | ToolFailure {
  const index = readIndex(directory);
  return typeof index === 'string' ? failure(index) : { index, packageRoot: dirname(directory) };
}

/** The text of a page of the index, read as a regular file inside the package; a link in its place is not followed. */
function readPage({ packageRoot }: Loaded, page: Page) {
  return readRegularIn(packageRoot, page.file, MAX_PAGE_BYTES);
}

/** The two tools over the documentation in `directory` (the `docs/` of the installed package). */
export function docsTools(directory: string): { readonly search: McpTool; readonly read: McpTool } {
  return {
    search: {
      name: 'docs_search',
      description: `Search the documentation of the installed marmeon for sections. Words must all appear in a section; titles and headings weigh more than text. Read a hit with docs_read. ${DATA_NOTICE}`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 2, maxLength: 200, description: 'Up to eight words to look for.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: DEFAULT_LIMIT, description: `At most this many sections (default ${DEFAULT_LIMIT}).` },
        },
        required: ['query'],
        additionalProperties: false,
      },
      spawns: false,
      run: (input) => Promise.resolve(search(directory, input)),
    },
    read: {
      name: 'docs_read',
      description: `Read a page of the documentation of the installed marmeon, or one section of it. Pages and sections are named as docs_search lists them. ${DATA_NOTICE}`,
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9-]{1,64}$', description: 'The slug of the page, for example "routing".' },
          section: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-z0-9_-]{1,128}$', description: 'The anchor of a section of that page, without "#".' },
        },
        required: ['page'],
        additionalProperties: false,
      },
      spawns: false,
      run: (input) => Promise.resolve(read(directory, input)),
    },
  };
}

const defaults = docsTools(new DocsLocation().directory);
export const DOCS_SEARCH_TOOL: McpTool = defaults.search;
export const DOCS_READ_TOOL: McpTool = defaults.read;

function termsOf(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((word) => word.length >= 2);
  return [...new Set(words)].slice(0, MAX_TERMS);
}

function occurrences(haystack: string, term: string): number {
  let count = 0;
  for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + term.length)) count++;
  return count;
}

interface Hit {
  readonly page: Page;
  readonly section: PageSection;
  readonly score: number;
  readonly matched: number;
  readonly order: number;
}

function search(directory: string, input: Readonly<Record<string, unknown>>): ToolDocument | ToolFailure {
  const query = typeof input.query === 'string' ? input.query : '';
  const limit = typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT;
  const terms = termsOf(query);
  if (terms.length === 0) return failure('The query has no word of two characters or more.');
  const loaded = load(directory);
  if ('failure' in loaded) return loaded;

  const hits: Hit[] = [];
  let order = 0;
  for (const page of loaded.index.sections.flatMap((section) => section.pages)) {
    const file = readPage(loaded, page);
    if (!file) continue;
    for (const section of sectionsOf(file.text)) {
      const title = section.heading === null ? page.title.toLowerCase() : '';
      const heading = section.heading?.toLowerCase() ?? '';
      const text = bodyOf(section).toLowerCase();
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const points = (title.includes(term) ? 5 : 0) + (heading.includes(term) ? 3 : 0) + occurrences(text, term);
        if (points > 0) matched++;
        score += Math.min(MAX_TERM_POINTS, points);
      }
      if (matched > 0) hits.push({ page, section, score, matched, order: order++ });
    }
  }
  const complete = hits.filter((hit) => hit.matched === terms.length);
  const chosen = complete.length > 0 ? complete : hits;
  const warnings = complete.length === 0 && hits.length > 0 && terms.length > 1 ? ['No section has all the words; these have some of them.'] : [];
  chosen.sort((a, b) => b.matched - a.matched || b.score - a.score || a.order - b.order);
  const results = chosen.slice(0, limit).map(({ page, section }) => ({
    slug: page.slug,
    title: page.title,
    heading: section.heading,
    anchor: section.anchor,
    file: section.anchor === null ? page.file : `${page.file}#${section.anchor}`,
    snippet: snippetOf(section, terms),
  }));
  return { format: 1, version: loaded.index.version, results, warnings };
}

/** Up to {@link MAX_SNIPPET} characters of the section's text around the first place one of the words appears. */
function snippetOf(section: PageSection, terms: readonly string[]): string {
  const body = bodyOf(section).replace(/\s+/g, ' ').trim();
  const lower = body.toLowerCase();
  const found = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const at = found.length > 0 ? Math.min(...found) : 0;
  // Two ellipses and, at most, one character moved on to keep a surrogate pair whole.
  const room = MAX_SNIPPET - 3;
  let start = Math.max(0, at - Math.floor(room / 3));
  let end = Math.min(body.length, start + room);
  if (end === body.length) start = Math.max(0, end - room);
  const cut = (index: number) => (index > 0 && index < body.length && isLowSurrogate(body.charCodeAt(index)) ? index + 1 : index);
  start = cut(start);
  end = cut(end);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

/** What a section says under its heading (the part before the first heading has no heading line to take off). */
function bodyOf(section: PageSection): string {
  return section.heading === null ? section.text : section.text.slice(section.text.indexOf('\n') + 1 || section.text.length);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function read(directory: string, input: Readonly<Record<string, unknown>>): ToolDocument | ToolFailure {
  const wanted = typeof input.page === 'string' ? input.page : '';
  const section = typeof input.section === 'string' ? input.section : undefined;
  const loaded = load(directory);
  if ('failure' in loaded) return loaded;
  // The page is found in the index by its slug and by nothing else: what was typed never becomes part of a path.
  const page = loaded.index.sections.flatMap((entry) => entry.pages).find((entry) => entry.slug === wanted);
  if (!page) {
    const similar = suggest(loaded.index, wanted);
    return failure(`There is no page "${printable(wanted)}" in the documentation of marmeon ${loaded.index.version}.${similar.length > 0 ? ` Did you mean ${similar.join(', ')}?` : ''}`);
  }
  const file = readPage(loaded, page);
  if (!file) return failure(`The page "${page.slug}" is in docs/index.json, but ${page.file} is not a file of this installation of marmeon.`);

  const warnings: string[] = file.truncated ? [`${page.file} is longer than ${MAX_PAGE_BYTES} bytes; the end was not read.`] : [];
  let text = file.text;
  if (section !== undefined) {
    const found = sectionsOf(file.text).find((candidate) => candidate.anchor === section);
    if (!found) {
      return failure(`The page "${page.slug}" has no section "${printable(section)}".${sectionList(file.text)}`);
    }
    text = found.whole;
  }
  const truncated = text.length > MAX_TEXT_CHARACTERS;
  if (truncated) {
    text = text.slice(0, isLowSurrogate(text.charCodeAt(MAX_TEXT_CHARACTERS)) ? MAX_TEXT_CHARACTERS - 1 : MAX_TEXT_CHARACTERS);
    warnings.push(`The text was cut at ${MAX_TEXT_CHARACTERS} characters. Read the rest with docs_read and a section.${sectionList(file.text)}`);
  }
  return { format: 1, slug: page.slug, title: page.title, file: section === undefined ? page.file : `${page.file}#${section}`, section: section ?? null, text, truncated: truncated || file.truncated, warnings };
}

/** A sentence that lists the anchors of the page's sections (at most {@link MAX_LISTED_ANCHORS}). */
function sectionList(markdown: string): string {
  const anchors = sectionsOf(markdown).flatMap((candidate) => (candidate.anchor === null ? [] : [candidate.anchor]));
  if (anchors.length === 0) return ' It has no sections.';
  return ` Its sections: ${anchors.slice(0, MAX_LISTED_ANCHORS).join(', ')}${anchors.length > MAX_LISTED_ANCHORS ? ', …' : ''}.`;
}

/** Typed text shown back in a message: one line, short. */
function printable(value: string): string {
  const line = value.replace(/[\r\n]+/g, ' ');
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
