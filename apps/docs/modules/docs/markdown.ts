import { posix } from 'node:path';
import GithubSlugger from 'github-slugger';
import MarkdownIt from 'markdown-it';
import type { Highlighter } from './highlight.ts';
import type { DocNode, TocEntry } from './types.ts';

type Token = ReturnType<InstanceType<typeof MarkdownIt>['parse']>[number];

/** An element while it is built — its children still growing. */
interface Building {
  t: string;
  a?: Record<string, string>;
  c: DocNode[];
}

const element = (t: string, a?: Record<string, string> | null): Building => (a ? { t, a, c: [] } : { t, c: [] });

/**
 * CommonMark + GFM tables and strikethrough. `html: false`: raw HTML in a README is text — `<script>` shows as
 * `<script>`, it never reaches the page as markup. markdown-it also refuses `javascript:`, `vbscript:`, `file:` and
 * `data:` URLs in links (they stay text).
 */
const markdown = new MarkdownIt('commonmark', { html: false, linkify: false, typographer: false }).enable(['table', 'strikethrough']);

/**
 * The mark of a page still to be written: a line of its own (a paragraph, outside code), by convention the file's second. The
 * page is `pending` — the navigation says "draft" — and the line is taken out before the page is built: with `html: false` it
 * would show as text.
 */
export const PENDING_MARKER = '<!-- docs:pending -->';

/** Where a link of a README points. */
export type LinkTarget =
  | { kind: 'page'; path: string; hash: string }
  | { kind: 'external'; href: string }
  | { kind: 'file'; path: string };

/** A section of a page for the search: what is under one heading (the intro: under the page's title). */
export interface Section {
  readonly heading: string;
  readonly anchor: string;
  readonly depth: number;
  readonly text: string;
}

export interface RenderedMarkdown {
  /** The text of the first `#` heading — the page's title (not part of `body`). */
  readonly title: string;
  readonly body: DocNode[];
  readonly toc: TocEntry[];
  readonly sections: Section[];
  /** Every heading id of the page (H1–H6), for the link check. */
  readonly anchors: string[];
  /** Links to files that are no page (`src/kernel.ts`) — shown as code text. */
  readonly fileLinks: string[];
  /** The page carries {@link PENDING_MARKER}. */
  readonly pending: boolean;
}

export interface RenderOptions {
  /** The file's path relative to the repository: `docs/routing.md`, `packages/core/README.md`. */
  readonly file: string;
  /** Which repository path is which page: `packages/core/README.md` → `/packages/core`. */
  readonly pageOf: (repoPath: string) => string | undefined;
  readonly highlight: Highlighter;
}

const ALERTS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

/** Renders one README: a node tree for the page, its table of contents (H2/H3) and its sections for the search. */
export function renderMarkdown(source: string, options: RenderOptions): RenderedMarkdown {
  const tokens = markdown.parse(source, {});
  const slugger = new GithubSlugger();
  const toc: TocEntry[] = [];
  const anchors: string[] = [];
  const fileLinks: string[] = [];
  const sections: { heading: string; anchor: string; depth: number; text: string[] }[] = [];
  let title = '';
  let pending = false;
  let section = { heading: '', anchor: '', depth: 1, text: [] as string[] };
  sections.push(section);

  const root: Building = element('div');
  const stack: Building[] = [root];
  const top = () => stack[stack.length - 1]!;
  const append = (node: Building | DocNode) => top().c.push(node);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.hidden) continue; // the paragraphs of a tight list
    if (token.type === 'paragraph_open' && tokens[i + 1]!.content.trim() === PENDING_MARKER) {
      pending = true;
      i += 2; // the inline and the close token
      continue;
    }
    switch (token.type) {
      case 'heading_open': {
        const inline = tokens[i + 1]!;
        const text = plainText(inline.children ?? []);
        const id = slugger.slug(text);
        anchors.push(id);
        const depth = Number(token.tag.slice(1));
        if (depth === 1 && !title) {
          title = text;
          section.heading = text;
          i += 2; // the inline and the close token
          continue;
        }
        if (depth === 2 || depth === 3) toc.push({ depth, text, id });
        section = { heading: text, anchor: id, depth, text: [] };
        sections.push(section);
        const heading = element(token.tag, { id });
        append(heading);
        stack.push(heading);
        break;
      }
      case 'heading_close': {
        const heading = stack.pop()!;
        heading.c.push({ t: 'a', a: { href: `#${heading.a!.id!}`, class: 'anchor', 'aria-hidden': 'true', tabindex: '-1' }, c: ['#'] });
        break;
      }
      case 'paragraph_open':
      case 'blockquote_open':
      case 'bullet_list_open':
      case 'list_item_open':
      case 'thead_open':
      case 'tbody_open':
      case 'tr_open': {
        const block = element(token.tag);
        append(block);
        stack.push(block);
        break;
      }
      case 'ordered_list_open': {
        const start = String(token.attrGet('start') ?? '1');
        const list = element('ol', start !== '1' ? { start } : null);
        append(list);
        stack.push(list);
        break;
      }
      case 'table_open': {
        // Wide tables scroll inside their own box on a phone, not the page.
        const wrapper = element('div', { class: 'table' });
        const table = element('table');
        wrapper.c.push(table);
        append(wrapper);
        stack.push(wrapper, table);
        break;
      }
      case 'th_open':
      case 'td_open': {
        const align = /text-align:(left|center|right)/.exec(String(token.attrGet('style') ?? ''))?.[1];
        const cell = element(token.tag, align ? { class: align } : null);
        append(cell);
        stack.push(cell);
        break;
      }
      case 'table_close':
        stack.pop();
        stack.pop();
        break;
      case 'blockquote_close':
        alert(stack.pop()!);
        break;
      case 'paragraph_close':
      case 'bullet_list_close':
      case 'ordered_list_close':
      case 'list_item_close':
      case 'thead_close':
      case 'tbody_close':
      case 'tr_close':
      case 'th_close':
      case 'td_close':
        stack.pop();
        break;
      case 'inline':
        // A heading's own words are the section's heading, not its text.
        inline(token.children ?? [], top(), /^h\d$/.test(top().t) ? [] : section.text);
        break;
      case 'fence':
      case 'code_block': {
        const { lang, title } = codeInfo(token.info);
        const code = { html: options.highlight(token.content, lang) };
        // The file a block shows, above it: a caption of text — React escapes it, quotes and markup alike.
        append(title ? { t: 'figure', a: { class: 'code' }, c: [{ t: 'figcaption', c: [title] }, code] } : code);
        section.text.push(token.content);
        break;
      }
      case 'hr':
        append(element('hr'));
        break;
      default:
        // html_block/html_inline never occur (`html: false`); anything else new is shown as its source text.
        if (token.content) append(token.content);
    }
  }

  function inline(children: Token[], parent: Building, sectionText: string[]): void {
    const text: string[] = [];
    const stack: Building[] = [parent];
    const top = () => stack[stack.length - 1]!;
    for (const token of children) {
      switch (token.type) {
        case 'text':
          top().c.push(token.content);
          text.push(token.content);
          break;
        case 'code_inline':
          top().c.push({ t: 'code', c: [token.content] });
          text.push(token.content);
          break;
        case 'softbreak':
          top().c.push('\n');
          text.push(' ');
          break;
        case 'hardbreak':
          top().c.push({ t: 'br' });
          text.push(' ');
          break;
        case 'strong_open':
        case 'em_open':
        case 's_open': {
          const inner = element(token.tag);
          top().c.push(inner);
          stack.push(inner);
          break;
        }
        case 'link_open': {
          const target = linkTarget(String(token.attrGet('href') ?? ''), options);
          // A link to a source file stays code text: the docs have no copy of the code to link to (E10: no remote).
          const link =
            target.kind === 'page'
              ? target.path === ''
                ? element('a', { href: target.hash })
                : element('a', { href: target.path + target.hash, 'data-internal': '' })
              : target.kind === 'external'
                ? element('a', { href: target.href, rel: 'noopener' })
                : element('span', { class: 'file' });
          if (target.kind === 'file') fileLinks.push(target.path);
          top().c.push(link);
          stack.push(link);
          break;
        }
        case 'strong_close':
        case 'em_close':
        case 's_close':
        case 'link_close':
          stack.pop();
          break;
        case 'image':
          // Images of a README live in the repository, not in this app: their text stands in.
          top().c.push(plainText(token.children ?? []));
          break;
        default:
          if (token.content) {
            top().c.push(token.content);
            text.push(token.content);
          }
      }
    }
    sectionText.push(text.join(''));
  }

  return {
    title,
    body: compact(root.c),
    toc,
    anchors,
    fileLinks,
    pending,
    sections: sections
      .map((s) => ({ heading: s.heading, anchor: s.anchor, depth: s.depth, text: s.text.join(' ').replace(/\s+/g, ' ').trim() }))
      .filter((s) => s.text || s.anchor),
  };
}

/** A fence's info string: its language (the first word) and the file it shows — ```` ```ts title="modules/notes/routes.ts" ````. */
function codeInfo(info: string): { lang: string; title: string } {
  const first = info.trim().split(/\s+/)[0] ?? '';
  const title = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)')/.exec(info);
  return { lang: first.startsWith('title=') ? '' : first, title: (title?.[1] ?? title?.[2] ?? '').trim() };
}

/** `> [!NOTE]` (GitHub's alerts) → a callout; any other blockquote stays one. */
function alert(quote: Building): void {
  const first = quote.c[0];
  if (typeof first !== 'object' || !('t' in first) || first.t !== 'p') return;
  const paragraph = first as Building;
  const lead = paragraph.c[0];
  const match = typeof lead === 'string' ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(lead) : null;
  if (!match) return;
  const rest = (lead as string).slice(match[0].length);
  paragraph.c.splice(0, 1, ...(rest ? [rest] : []));
  if (paragraph.c[0] === '\n') paragraph.c.splice(0, 1);
  if (paragraph.c.length === 0) quote.c.splice(0, 1);
  quote.t = 'aside';
  quote.a = { class: `callout ${match[1]!.toLowerCase()}`, role: 'note' };
  quote.c.unshift({ t: 'p', a: { class: 'callout-title' }, c: [ALERTS[match[1]!]!] });
}

/** The finished tree: no empty child lists (a page has thousands of elements). */
function compact(nodes: readonly (DocNode | Building)[]): DocNode[] {
  return nodes.map((node) => {
    if (typeof node === 'string' || 'html' in node) return node;
    const children = node.c ? compact(node.c as (DocNode | Building)[]) : [];
    return { t: node.t, ...(node.a ? { a: node.a } : {}), ...(children.length > 0 ? { c: children } : {}) };
  });
}

/** Where `href` of `options.file` leads: a page of this app, another site, or a file of the repository. */
export function linkTarget(href: string, options: Pick<RenderOptions, 'file' | 'pageOf'>): LinkTarget {
  if (href.startsWith('#')) return { kind: 'page', path: '', hash: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return { kind: 'external', href };
  const at = href.indexOf('#');
  const path = at === -1 ? href : href.slice(0, at);
  const hash = at === -1 ? '' : href.slice(at);
  const resolved = posix.normalize(posix.join(posix.dirname(options.file), decodeURIComponent(path))).replace(/\/$/, '');
  const page = options.pageOf(resolved) ?? options.pageOf(`${resolved}/README.md`) ?? missingPage(resolved);
  if (page === undefined) return { kind: 'file', path: resolved };
  // A link into the page itself stays an anchor: the browser scrolls, no visit.
  return page === options.pageOf(options.file) && hash ? { kind: 'page', path: '', hash } : { kind: 'page', path: page, hash };
}

/**
 * A README the docs do not have (a typo, a package that is gone): still a page link — the link check reports it. The root
 * README is no page (the start page is the app's own): a link to it stays code text, as on any file.
 */
function missingPage(path: string): string | undefined {
  const name = /^packages\/([^/]+)(?:\/README\.md)?$/.exec(path)?.[1];
  return name ? `/packages/${name}` : path.endsWith('/README.md') ? `/${path}` : undefined;
}

/** The text of inline tokens, as GitHub reads a heading for its anchor (code spans without their backticks). */
function plainText(tokens: Token[]): string {
  return tokens.map((token) => (token.type === 'softbreak' || token.type === 'hardbreak' ? ' ' : token.children ? plainText(token.children) : token.content)).join('');
}
