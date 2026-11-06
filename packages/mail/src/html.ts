import { Html } from '@marmeon/core';
import type { MailContent } from './message.ts';

// The escaping template lives in core (the devtools render with it too); mail re-exports it unchanged.
export { escapeHtml, Html, html, raw } from '@marmeon/core';
/** @internal — shared by the `html` and `mjml` templates. */
export { interpolateHtml as interpolate } from '@marmeon/core/internal';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#96': '`', nbsp: ' ' };

/**
 * `markup` without its tags, each running from a `<` to the next `>` (`<>` is none). A scan, not `/<[^>]+>/g`: that retries the
 * rest of the text from every `<` of a long run without a `>`, which is quadratic.
 */
export function withoutTags(markup: string): string {
  let out = '';
  let from = 0;
  let open = markup.indexOf('<');
  while (open !== -1) {
    const end = markup.indexOf('>', open + 1);
    if (end === -1) break; // no `>` is left: nothing further can match
    if (end === open + 1) {
      open = markup.indexOf('<', end);
      continue;
    }
    out += markup.slice(from, open);
    from = end + 1;
    open = markup.indexOf('<', from);
  }
  return out + markup.slice(from);
}

/** What a scan found at a position: where the match ends and what replaces it. */
interface Hit {
  end: number;
  replacement: string;
}

/** The text a pass runs over, with the searches its matchers share. */
interface Scan {
  text: string;
  /** `text` with A–Z lowered (same length), for the case-insensitive tags. */
  lower: string;
  /** The first start of `needle` (lower case) at or after `from`, or -1. */
  find(needle: string, from: number): number;
  /** The first start of `display:`, blanks, `none` at or after `from`, or -1. */
  findDisplayNone(from: number): number;
}

/**
 * The searches remember their last answer: matchers run at increasing positions and ask many times for the same next `>` or
 * `</a>`, and each ask would walk the same stretch again.
 */
function scanner(text: string): Scan {
  // Only ASCII: `toLowerCase()` changes the length of a few characters (every index here is the text's), and a `/i` regex without
  // `u` folds only ASCII — `K` (Kelvin) never matched `k`.
  const lower = text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  const lasts = new Map<string, number>();
  const remembered = new Map<string, { from: number; at: number }>();
  const search = (key: string, from: number, run: () => number): number => {
    const last = remembered.get(key);
    if (last && from >= last.from && (last.at === -1 || last.at >= from)) return last.at;
    const at = run();
    remembered.set(key, { from, at });
    return at;
  };
  const displayNone = /display:\s*none/g;
  return {
    text,
    lower,
    find(needle, from) {
      return search(needle, from, () => {
        let last = lasts.get(needle);
        if (last === undefined) lasts.set(needle, (last = lower.lastIndexOf(needle)));
        return from > last ? -1 : lower.indexOf(needle, from); // past the last one there is nothing to walk to
      });
    },
    findDisplayNone(from) {
      return search('display:none', from, () => {
        displayNone.lastIndex = from;
        return displayNone.exec(lower)?.index ?? -1;
      });
    },
  };
}

/**
 * `markup` with each match of `match` replaced, tried at every start of `first` (lower case) from left to right and, after a
 * match, from its end — the way a global regex replaces. The passes below are scans, not regexes: a lazy `[\s\S]*?` or a
 * `[^>]*` that finds no end retries the rest of the text from every start, which is quadratic.
 */
function rewrite(markup: string, first: string, match: (scan: Scan, at: number) => Hit | undefined): string {
  const scan = scanner(markup);
  let out = '';
  let copied = 0;
  let at = scan.find(first, 0);
  while (at !== -1) {
    const hit = match(scan, at);
    if (hit) {
      out += markup.slice(copied, at) + hit.replacement;
      copied = hit.end;
      at = scan.find(first, hit.end);
    } else {
      at = scan.find(first, at + 1);
    }
  }
  return out + markup.slice(copied);
}

/** Whether `char` is a regex word character (`\w`): after a tag name, `\b` is where it is not. */
const isWordChar = (char: string | undefined): boolean => char !== undefined && /\w/.test(char);

const DROPPED = ['style', 'script', 'head', 'title'];
const HIDDEN = ['div', 'span'];

/** `<!--` up to `-->`: comments, Outlook's conditional ones included. */
const withoutComments = (markup: string): string =>
  rewrite(markup, '<!--', (scan, at) => {
    const close = scan.find('-->', at + 4);
    return close === -1 ? undefined : { end: close + 3, replacement: '' };
  });

/** `<style …>` up to `</style>`, and the same for script, head and title. */
const withoutDroppedBlocks = (markup: string): string =>
  rewrite(markup, '<', (scan, at) => {
    const name = DROPPED.find((candidate) => scan.lower.startsWith(candidate, at + 1));
    if (!name) return undefined;
    const open = scan.find('>', at + 1);
    if (open === -1) return undefined;
    const close = scan.find(`</${name}>`, open + 1);
    return close === -1 ? undefined : { end: close + name.length + 3, replacement: '' };
  });

/** A `div` or `span` whose tag says `display:none`, up to its closing tag: hidden preheaders. */
const withoutHiddenBlocks = (markup: string): string =>
  rewrite(markup, '<', (scan, at) => {
    const name = HIDDEN.find((candidate) => scan.lower.startsWith(candidate, at + 1));
    if (!name || isWordChar(scan.lower[at + 1 + name.length])) return undefined;
    const open = scan.find('>', at + 1);
    if (open === -1) return undefined;
    const hidden = scan.findDisplayNone(at + 1);
    if (hidden === -1 || hidden > open) return undefined;
    const close = scan.find(`</${name}>`, open + 1);
    return close === -1 ? undefined : { end: close + name.length + 3, replacement: '' };
  });

/** The `href="` starts of the tags that end at one `>`: the last two, which are the only ones a match can end up using. */
interface Hrefs {
  open: number;
  last?: number;
  before?: number;
  /** Where each one's value ends (its closing quote) and its tag ends (the next `>`); `undefined` when either is missing. */
  read: Map<number, { quote: number; end: number } | undefined>;
}

/**
 * `<a … href="…" …>label</a>` as `label (href)`. The href is the last `href="` in the tag whose value has a closing quote and a
 * `>` after it (the value may hold a `>`) and a `</a>` after that, else the one before it.
 */
const linksAsText = (markup: string): string => {
  let hrefs: Hrefs | undefined;
  return rewrite(markup, '<a', (scan, at) => {
    if (isWordChar(scan.lower[at + 2])) return undefined;
    const open = scan.find('>', at + 2);
    if (open === -1) return undefined;
    if (hrefs?.open !== open) {
      // The tags before one `>` share its candidates, found once; those left of a tag's start are skipped below.
      const found: Hrefs = (hrefs = { open, read: new Map() });
      for (let href = scan.find('href="', at + 2); href !== -1 && href < open; href = scan.find('href="', href + 1)) {
        found.before = found.last;
        found.last = href;
      }
    }
    for (const href of [hrefs.last, hrefs.before]) {
      if (href === undefined || href < at + 2) continue;
      if (!hrefs.read.has(href)) {
        const quote = scan.find('"', href + 6);
        const end = quote === -1 ? -1 : scan.find('>', quote + 1);
        hrefs.read.set(href, end === -1 ? undefined : { quote, end });
      }
      const read = hrefs.read.get(href);
      if (!read) continue;
      const close = scan.find('</a>', read.end + 1);
      if (close === -1) continue; // as a regex would, try the href before it, whose tag ends earlier
      const target = scan.text.slice(href + 6, read.quote);
      const label = withoutTags(scan.text.slice(read.end + 1, close)).trim();
      return { end: close + 4, replacement: label && label !== target ? `${label} (${target})` : target };
    }
    return undefined;
  });
};

/** `<li …>` as a dash. */
const listItemsAsDashes = (markup: string): string =>
  rewrite(markup, '<li', (scan, at) => {
    if (isWordChar(scan.lower[at + 3])) return undefined;
    const open = scan.find('>', at + 3);
    return open === -1 ? undefined : { end: open + 1, replacement: '- ' };
  });

/**
 * A plain-text version of an HTML mail: block elements become line breaks, links keep their URL
 * (`Reset password (https://…)`), tags and styles go. Good enough for transactional mails.
 */
export function textFromHtml(markup: string): string {
  const marked = listItemsAsDashes(
    linksAsText(withoutHiddenBlocks(withoutDroppedBlocks(withoutComments(markup))))
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|blockquote|section|header|footer)>/gi, '\n\n'),
  );
  const text = withoutTags(marked).replace(/&(#\d+|\w+);/g, (match, entity: string) => ENTITIES[entity] ?? (entity.startsWith('#') ? codePointText(Number(entity.slice(1))) ?? match : match));
  // Blanks around a line break go in one pass over the lines: a regex that retries a run of spaces at each of its characters is quadratic.
  return text
    .split('\n')
    .map(trimBlanks) // the indentation of compiled templates included
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The character of a numeric entity; `undefined` beyond Unicode, where `String.fromCodePoint` would throw. */
function codePointText(code: number): string | undefined {
  return code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}

/** `line` without the spaces and tabs at both ends. */
function trimBlanks(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && (line[start] === ' ' || line[start] === '\t')) start++;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return line.slice(start, end);
}

/** Content from an `html` template: the HTML, and a text version derived from it (or given). */
export function fromHtml(body: Html, text?: string): MailContent {
  const markup = Html.prototype.toString.call(body);
  return { html: markup, text: text ?? textFromHtml(markup) };
}
