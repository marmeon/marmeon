import { Html } from '@marmeon/core';
import type { MailContent } from './message.ts';

// The escaping template lives in core (the devtools render with it too); mail re-exports it unchanged.
export { escapeHtml, Html, html, raw } from '@marmeon/core';
/** @internal — shared by the `html` and `mjml` templates. */
export { interpolateHtml as interpolate } from '@marmeon/core/internal';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#96': '`', nbsp: ' ' };

/**
 * A plain-text version of an HTML mail: block elements become line breaks, links keep their URL
 * (`Reset password (https://…)`), tags and styles go. Good enough for transactional mails.
 */
export function textFromHtml(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, '') // comments, Outlook's conditional ones included
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(div|span)\b[^>]*display:\s*none[^>]*>[\s\S]*?<\/\1>/gi, '') // hidden preheaders
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|blockquote|section|header|footer)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|\w+);/g, (match, entity: string) => ENTITIES[entity] ?? (entity.startsWith('#') ? String.fromCodePoint(Number(entity.slice(1))) : match))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n') // the indentation of compiled templates
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Content from an `html` template: the HTML, and a text version derived from it (or given). */
export function fromHtml(body: Html, text?: string): MailContent {
  const markup = Html.prototype.toString.call(body);
  return { html: markup, text: text ?? textFromHtml(markup) };
}
