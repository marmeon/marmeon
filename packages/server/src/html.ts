import { CSP_NONCE_PLACEHOLDER } from '@marmeon/core';
import { PAGE_SCRIPT_ID, scriptJson, type PageObject, type SsrResult } from '@marmeon/http';

/** Placeholders an app's `index.html` provides. */
export const HEAD_OUTLET = '<!--app-head-->';
export const HTML_OUTLET = '<!--app-html-->';

/** Minimal template used when no app template is configured (tests, API-only apps). */
export const FALLBACK_TEMPLATE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Marmeon</title>${HEAD_OUTLET}</head>
  <body><div id="app">${HTML_OUTLET}</div></body>
</html>`;

const NONCE_ATTRIBUTE = ` nonce="${CSP_NONCE_PLACEHOLDER}"`;

/**
 * The template with the response's CSP nonce in place of {@link CSP_NONCE_PLACEHOLDER} — which Vite's `html.cspNonce`
 * (set by `marmeon()`) put on every script, style and preload tag, and `DevDocument`'s HTML carries — or, for a response
 * without one, with those `nonce` attributes taken out.
 */
export function withNonce(template: string, nonce: string | undefined): string {
  if (!template.includes(CSP_NONCE_PLACEHOLDER)) return template;
  return nonce ? template.replaceAll(CSP_NONCE_PLACEHOLDER, nonce) : template.replaceAll(NONCE_ATTRIBUTE, '');
}

export function serializePage(page: PageObject): string {
  // `<` is escaped so props can never close the script tag early.
  return scriptJson(page);
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
 * and the shell at once and the rest of the markup as it is rendered. `onCancel`: the body was cancelled (the client
 * went away) — before the markup's stream is.
 *
 * The shell is read before the stream is handed over (the SSR entry resolved with it ready), so the head and the shell
 * are both there for the server's first write: a server that waits a tick for more when a body is not complete yet
 * (`@hono/node-server` does) would otherwise send the headers only after it — while the islands' requests run.
 */
export async function documentOf(
  template: string,
  page: PageObject,
  ssr: SsrResult,
  onCancel?: (reason: unknown) => void,
): Promise<string | ReadableStream<Uint8Array>> {
  // The deferred groups the render streams: the browser waits for them instead of asking.
  const sent = ssr.streamedProps && ssr.streamedProps.length > 0 ? { ...page, streamedProps: ssr.streamedProps } : page;
  if (typeof ssr.html === 'string') return renderDocument(template, sent, { html: ssr.html, head: ssr.head });
  const { before, after } = documentAround(template, sent, ssr.head);
  const markup = ssr.html.getReader();
  const shell = await markup.read();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(before));
      if (!shell.done) return controller.enqueue(shell.value);
      controller.enqueue(encoder.encode(after));
      controller.close();
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
