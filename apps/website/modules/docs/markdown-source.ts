import { GITHUB_URL } from '../site/links.ts';
import { linkTarget, markdownParser, type RenderOptions } from './markdown.ts';

type Token = ReturnType<typeof markdownParser.parse>[number];

/** The destination of a link or an image in a page's source. */
export interface SourceLink {
  /** Offset of the destination in the source — after a leading `<`. */
  readonly start: number;
  /** Offset after the destination — before a closing `>`. */
  readonly end: number;
  /** The destination as written. */
  readonly href: string;
  readonly kind: 'link' | 'image';
}

/**
 * Where the destinations `](…)` of a page's source are, outside code. The page is served as Markdown with some of them
 * rewritten, so the positions must be right: a small scanner finds them, and the result is checked against markdown-it's own
 * reading of the page — the same destinations in the same order, or the page is refused (`problem`) and the app does not start.
 * That is what keeps the scanner from needing the whole CommonMark grammar, and from silently changing text it misread.
 */
export function sourceLinks(source: string): { links: SourceLink[] } | { problem: string } {
  const tokens = markdownParser.parse(source, {});
  const lineStart = [0];
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) lineStart.push(at + 1);
  const links: SourceLink[] = [];
  // Block by block: a code span or an escape never pairs across a block's edge, as in the renderer. A table row is one unit (its
  // cells' inline tokens have no line range of their own); any other inline token without a range is refused, never skipped.
  const units: { map: readonly [number, number]; children: Token[] }[] = [];
  let row: { map: readonly [number, number]; children: Token[] } | undefined;
  for (const token of tokens) {
    if (token.type === 'tr_open' && token.map) row = { map: token.map, children: [] };
    else if (token.type === 'tr_close' && row) {
      units.push(row);
      row = undefined;
    } else if (token.type === 'inline') {
      if (token.map) units.push({ map: token.map, children: token.children ?? [] });
      else if (row) row.children.push(...(token.children ?? []));
      else return { problem: `a block the scanner cannot place (near "${token.content.slice(0, 30).replace(/\s+/g, ' ')}") — write links inline: [text](target)` };
    }
  }
  for (const unit of units) {
    const from = lineStart[unit.map[0]] ?? source.length;
    const to = lineStart[unit.map[1]] ?? source.length;
    const found = scan(source.slice(from, to)).map((link) => ({ ...link, start: link.start + from, end: link.end + from }));
    const expected = renderedLinks(unit.children);
    for (let at = 0; at < Math.max(found.length, expected.length); at++) {
      const link = found[at];
      const rendered = expected[at];
      if (link && rendered && markdownParser.normalizeLink(markdownParser.utils.unescapeAll(link.href)) === rendered.href) {
        // The scanner cannot tell a link from an image; the renderer's token can.
        links.push({ ...link, kind: rendered.kind });
        continue;
      }
      const near = link ? source.slice(Math.max(0, link.start - 20), link.end + 10) : (rendered?.href ?? '');
      return { problem: `a link the source and the renderer read differently (near "${near.replace(/\s+/g, ' ')}") — write links inline: [text](target)` };
    }
  }
  return { links };
}

/** `source` with the destinations `href` names instead — only where it differs from what is written. */
export function replaceLinks(source: string, links: readonly SourceLink[], href: (link: SourceLink) => string): string {
  let result = source;
  for (const link of [...links].reverse()) {
    const replacement = href(link);
    if (replacement !== link.href) result = result.slice(0, link.start) + replacement + result.slice(link.end);
  }
  return result;
}

/** How a link to a page is written: `routing.md` next to the page, or an absolute URL (pages joined into one file). */
export type LinkStyle = { readonly kind: 'sibling' } | { readonly kind: 'absolute'; readonly url: (path: string) => string };

export interface ServedHrefOptions extends Pick<RenderOptions, 'file' | 'pageOf'> {
  /** The page's own path: `/docs/routing`. */
  readonly self: string;
  /** Where the pages are served (`/docs`, or `/docs/<line>`); defaults to `/docs`. */
  readonly base?: string;
  /** The Git ref a link to a file that is no page points at; defaults to `main`. */
  readonly githubRef?: string;
  readonly style: LinkStyle;
}

/**
 * The destination as `/docs/<slug>.md` serves it: a link to a page leads to that page's `.md`, a link to a file that is no page
 * (`README.md`) to GitHub; anchors, external links and images stay.
 */
export function servedHref(link: SourceLink, options: ServedHrefOptions): string {
  if (link.kind === 'image') return link.href;
  // The value the renderer reads (and the boot check compares): unescaped and percent-encoded.
  const value = markdownParser.normalizeLink(markdownParser.utils.unescapeAll(link.href));
  const target = linkTarget(value, options);
  const hash = value.includes('#') ? value.slice(value.indexOf('#')) : '';
  const { style } = options;
  const base = options.base ?? '/docs';
  switch (target.kind) {
    case 'external':
      return link.href;
    case 'file':
      return `${GITHUB_URL}/blob/${options.githubRef ?? 'main'}/${target.path}${hash}`;
    case 'page': {
      const path = target.path === '' ? options.self : target.path;
      if (!path.startsWith(`${base}/`)) return link.href;
      if (style.kind === 'absolute') return style.url(`${path}.md`) + target.hash;
      // A bare anchor stays; a link to the page by its file name becomes its sibling form.
      if (target.path === '' && value.startsWith('#')) return link.href;
      return `${path.slice(base.length + 1)}.md${target.hash}`;
    }
  }
}

/** The links and images markdown-it read, in document order (autolinks have no `](`). */
function renderedLinks(tokens: readonly Token[]): { kind: 'link' | 'image'; href: string }[] {
  const found: { kind: 'link' | 'image'; href: string }[] = [];
  const visit = (list: readonly Token[]) => {
    for (const token of list) {
      if (token.type === 'link_open' && token.markup !== 'autolink') found.push({ kind: 'link', href: String(token.attrGet('href') ?? '') });
      else if (token.type === 'image') found.push({ kind: 'image', href: String(token.attrGet('src') ?? '') });
      if (token.children) visit(token.children);
    }
  };
  visit(tokens);
  return found;
}

/** Finds `](destination)` in one block's text, outside code spans. */
function scan(text: string): SourceLink[] {
  const links: SourceLink[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === '\\') {
      at += 2;
    } else if (char === '`') {
      const run = backtickRun(text, at);
      const close = findRun(text, at + run, run);
      at = close === -1 ? at + run : close + run;
    } else if (char === ']' && text[at + 1] === '(') {
      const link = destination(text, at + 2);
      links.push(link);
      at = link.end;
    } else {
      at++;
    }
  }
  return links;
}

const backtickRun = (text: string, from: number): number => {
  let end = from;
  while (text[end] === '`') end++;
  return end - from;
};

/** The start of the next run of exactly `length` backticks at or after `from`, or -1. */
function findRun(text: string, from: number, length: number): number {
  let at = from;
  while (at < text.length) {
    if (text[at] === '`') {
      const run = backtickRun(text, at);
      if (run === length) return at;
      at += run;
    } else {
      at++;
    }
  }
  return -1;
}

/** The destination from `from` (after `](`): `<…>`, or up to whitespace or an unbalanced `)`. */
function destination(text: string, from: number): SourceLink {
  let start = from;
  while (/\s/.test(text[start] ?? '')) start++;
  let end = start;
  if (text[start] === '<') {
    start++;
    end = start;
    while (end < text.length && text[end] !== '>' && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
    return { start, end: Math.min(end, text.length), href: text.slice(start, end), kind: 'link' };
  }
  let depth = 0;
  while (end < text.length && !/\s/.test(text[end]!)) {
    if (text[end] === '\\') {
      end += 2;
      continue;
    }
    if (text[end] === '(') depth++;
    else if (text[end] === ')') {
      if (depth === 0) break;
      depth--;
    }
    end++;
  }
  end = Math.min(end, text.length);
  return { start, end, href: text.slice(start, end), kind: 'link' };
}
