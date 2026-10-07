/**
 * The escaping `html` template — for HTML the server writes itself: mails (@marmeon/mail re-exports it), the devtools'
 * pages (W7 step 8). Moved here from @marmeon/mail so a package that renders HTML does not need the mail package.
 */

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

/** Text for element content and quoted attributes: `& < > " ' \`` escaped. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (char) => ESCAPES[char]!);
}

/** One interpolated value: `Html` kept, arrays joined, `null`/`undefined`/`false` gone, everything else escaped text. */
export function interpolateHtml(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.toString();
  if (Array.isArray(value)) return value.map(interpolateHtml).join('');
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
  for (let i = 0; i < values.length; i++) out += interpolateHtml(values[i]) + strings[i + 1]!;
  return new Html(out);
}

/** Markup you trust as it is — never with user input. */
export function raw(markup: string): Html {
  return new Html(markup);
}
