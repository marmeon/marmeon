/**
 * The escaping `html` template — for HTML the server writes itself: mails (@marmeon/mail re-exports it), the devtools'
 * pages. In the core, so a package that renders HTML does not need the mail package.
 */

/** The key the constructor of `Html` asks for; only this module and `Mjml` (through `@marmeon/core/internal`) hold it. @internal */
export const HTML_KEY = Symbol('Html');

// The static block of `Html` and the key are the only way to an Html.
let makeHtml: (markup: string) => Html;

/**
 * HTML that is already safe — what the `html` template returns; nested, it is not escaped again. Made by `html` and `raw()`
 * only (`Mjml` in @marmeon/mail extends it) — the type decides that a response is HTML.
 */
export class Html {
  static {
    makeHtml = (markup) => new Html(markup, HTML_KEY);
  }

  readonly #html: string;

  /**
   * `protected` only for `Mjml` in @marmeon/mail; without the key it throws, so `new Html(markup)` is `raw(markup)` for markup you trust.
   * @internal
   */
  protected constructor(html: string, key: symbol) {
    if (key !== HTML_KEY) throw new TypeError('An Html is made by the html template or raw() — new Html(markup) is raw(markup), for markup you trust.');
    this.#html = html;
  }

  toString(): string {
    return this.#html;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** @internal The `html` template escapes; this alone is right only in element content and quoted attributes: `& < > " ' \`` escaped. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (char) => ESCAPES[char]!);
}

/** One interpolated value: `Html` kept, arrays joined, `null`/`undefined`/`false` gone, everything else escaped text. */
export function interpolateHtml(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return Html.prototype.toString.call(value);
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
  return makeHtml(out);
}

/** Markup you trust as it is — never with user input. */
export function raw(markup: string): Html {
  return makeHtml(markup);
}
