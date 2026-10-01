import type { MailContent } from './message.ts';

/** HTML that is already safe — what the `html` template returns; nested, it is not escaped again. */
export class Html {
  readonly #html: string;

  constructor(html: string) {
    this.#html = html;
  }

  toString(): string {
    return this.#html;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (char) => ESCAPES[char]!);
}

/** @internal — shared by the `html` and `mjml` templates. */
export function interpolate(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.toString();
  if (Array.isArray(value)) return value.map(interpolate).join('');
  return escapeHtml(String(value));
}

/**
 * HTML with every interpolated value escaped — a name like `<script>` arrives as text. `Html`
 * values (nested templates, `raw()`) are kept; arrays are joined; `null`/`undefined`/`false` vanish.
 *
 * ```ts
 * html`<p>Hello ${user.name}</p><ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`
 * ```
 *
 * Escaping makes values safe as text and inside quoted attributes. It does not judge URLs: put only
 * URLs you built yourself into `href` (a user's `javascript:` link stays a `javascript:` link).
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1]!;
  return new Html(out);
}

/** Markup you trust as it is — never with user input. */
export function raw(markup: string): Html {
  return new Html(markup);
}

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
  const markup = body.toString();
  return { html: markup, text: text ?? textFromHtml(markup) };
}
