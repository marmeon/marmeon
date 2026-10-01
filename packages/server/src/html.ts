import { PAGE_SCRIPT_ID, type PageObject, type SsrResult } from '@bespokecore/http';

/** Placeholders an app's `index.html` provides. */
export const HEAD_OUTLET = '<!--app-head-->';
export const HTML_OUTLET = '<!--app-html-->';

/** Minimal template used when no app template is configured (tests, API-only apps). */
export const FALLBACK_TEMPLATE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>BespokeCore</title>${HEAD_OUTLET}</head>
  <body><div id="app">${HTML_OUTLET}</div></body>
</html>`;

export function serializePage(page: PageObject): string {
  // `<` is escaped so props can never close the script tag early.
  return JSON.stringify(page).replaceAll('<', '\\u003c');
}

/**
 * The document around the page's markup: the template up to the markup — with the `<Head>` tags and the page object —
 * and the rest after it. The page object goes into the head, so the browser has it before the markup: a page that is
 * still streaming can hydrate its shell while the rest arrives. Replacer *functions* are used on purpose: with string
 * replacements, `$&` or `$'` inside rendered HTML would be expanded.
 */
export function documentAround(template: string, page: PageObject, head = ''): { before: string; after: string } {
  const at = template.indexOf(HTML_OUTLET);
  if (at === -1) throw new Error(`index.html is missing the ${HTML_OUTLET} outlet.`);

  const pageScript = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${serializePage(page)}</script>`;
  // A page title from <Head> replaces the template's default <title>.
  let before = /<title[\s>]/.test(head) ? template.slice(0, at).replace(/<title>[\s\S]*?<\/title>\s*/, '') : template.slice(0, at);
  before = withLang(before, page.locale);
  before = before.includes(HEAD_OUTLET) ? before.replace(HEAD_OUTLET, () => head) : before;
  before = before.includes('</head>') ? before.replace('</head>', () => `${pageScript}\n</head>`) : `${before}${pageScript}`;
  return { before, after: template.slice(at + HTML_OUTLET.length) };
}

/** A language tag — letters, digits and hyphens (BCP 47). Anything else never reaches the document. */
const LANGUAGE_TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;

/** `<html lang>` of the template set to the page's locale (the template's own when the page has none). */
export function withLang(html: string, locale: string | undefined): string {
  if (!locale || !LANGUAGE_TAG.test(locale)) return html;
  return html.replace(/<html\b([^>]*)>/i, (_tag, attributes: string) => {
    const rest = attributes.replace(/\slang\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '');
    return `<html lang="${locale}"${rest}>`;
  });
}

/** The whole document as a string — for markup that is a string (or none: the browser renders the page). */
export function renderDocument(template: string, page: PageObject, { html, head = '' }: { html: string; head?: string }): string {
  const { before, after } = documentAround(template, page, head);
  return before + html + after;
}

const encoder = new TextEncoder();

/**
 * The document for server-rendered markup: a string when the markup is one, else a stream that sends the head
 * (and the shell's first bytes) at once and the rest of the markup as it is rendered. `onCancel`: the body was
 * cancelled (the client went away) — before the markup's stream is.
 */
export function documentOf(
  template: string,
  page: PageObject,
  ssr: SsrResult,
  onCancel?: (reason: unknown) => void,
): string | ReadableStream<Uint8Array> {
  if (typeof ssr.html === 'string') return renderDocument(template, page, { html: ssr.html, head: ssr.head });
  const { before, after } = documentAround(template, page, ssr.head);
  const markup = ssr.html.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(before));
    },
    async pull(controller) {
      const { done, value } = await markup.read();
      if (!done) return controller.enqueue(value);
      controller.enqueue(encoder.encode(after));
      controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
      return markup.cancel(reason);
    },
  });
}
