import { Html } from '@marmeon/core';
import type { MailContent } from './message.ts';

// The escaping template lives in core (the devtools render with it too); mail re-exports it unchanged.
export { escapeHtml, Html, html, raw } from '@marmeon/core';
/** @internal — shared by the `html` and `mjml` templates. */
export { interpolateHtml as interpolate } from '@marmeon/core/internal';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#96': '`', nbsp: ' ' };

// A `<` ends the tag it sits in (`<a<b>` leaves `<a`): with `[^>]` a run of `<` without a `>` scans the rest of the text from each of them.
const TAG = /<[^<>]+>/g;

/**
 * A plain-text version of an HTML mail: block elements become line breaks, links keep their URL
 * (`Reset password (https://…)`), tags and styles go. Good enough for transactional mails.
 */
export function textFromHtml(markup: string): string {
  const text = markup
    .replace(/<!--[\s\S]*?-->/g, '') // comments, Outlook's conditional ones included
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(div|span)\b[^>]*display:\s*none[^>]*>[\s\S]*?<\/\1>/gi, '') // hidden preheaders
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const text = label.replace(TAG, '').trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|blockquote|section|header|footer)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(TAG, '')
    .replace(/&(#\d+|\w+);/g, (match, entity: string) => ENTITIES[entity] ?? (entity.startsWith('#') ? codePointText(Number(entity.slice(1))) ?? match : match));
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
