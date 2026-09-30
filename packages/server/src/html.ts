import { PAGE_SCRIPT_ID, type PageObject, type SsrResult } from '@bespokecore/core';

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
 * Fills the template outlets. Replacer *functions* are used on purpose: with
 * string replacements, `$&` or `$'` inside rendered HTML would be expanded.
 */
export function renderDocument(template: string, page: PageObject, { html, head = '' }: SsrResult): string {
  const pageScript = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${serializePage(page)}</script>`;

  if (!template.includes(HTML_OUTLET)) {
    throw new Error(`index.html is missing the ${HTML_OUTLET} outlet.`);
  }

  return template
    .replace(HEAD_OUTLET, () => head)
    .replace(HTML_OUTLET, () => html)
    .replace('</body>', () => `${pageScript}\n</body>`);
}
