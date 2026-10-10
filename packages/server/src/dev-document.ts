import { currentRequest } from '@marmeon/core';

/** The request a development document is rendered for — what markup made per request may use. */
export interface DevRequest {
  /** Its id (`x-request-id`) — as the client sent it, or made by the kernel: escape it before it goes into HTML. */
  readonly requestId: string | undefined;
}

/** Markup — fixed, or made for each document (`(request) => …`). */
export type DevMarkup = string | ((request: DevRequest) => string);

/**
 * Development only: HTML the Vite dev renderer adds to every document — before `</body>`, outside the app's root (hydration
 * never sees it), or with `at: 'head'` before `</head>`, ahead of the app's entry. Bound only with `NODE_ENV=development`; the
 * production renderer never reads it. The markup is trusted: a function that puts anything of the request into it escapes it.
 * A `<script>` or `<style>` writes `nonce="__marmeon_csp_nonce__"` (`CSP_NONCE_PLACEHOLDER`), which the renderer replaces
 * with the response's nonce.
 */
export class DevDocument {
  readonly #body: DevMarkup[] = [];
  readonly #head: DevMarkup[] = [];

  /** Adds `markup` to the end of every development document's body — or of its head (`at: 'head'`). */
  add(markup: DevMarkup, { at = 'body' }: { readonly at?: 'head' | 'body' } = {}): this {
    (at === 'head' ? this.#head : this.#body).push(markup);
    return this;
  }

  /** What goes before `</body>` — for the request being handled. */
  get body(): string {
    return render(this.#body);
  }

  /** What goes before `</head>` — for the request being handled. */
  get head(): string {
    return render(this.#head);
  }
}

function render(markup: readonly DevMarkup[]): string {
  const request: DevRequest = { requestId: currentRequest()?.requestId };
  return markup.map((part) => (typeof part === 'string' ? part : part(request))).join('\n');
}

/** The template with `body` before its `</body>` (or at its end without one) — and `head` before its `</head>` (or at its start). */
export function withDevBody(template: string, body: string, head = ''): string {
  let html = template;
  if (head !== '') {
    const at = html.indexOf('</head>');
    html = at === -1 ? `${head}${html}` : `${html.slice(0, at)}${head}\n${html.slice(at)}`;
  }
  if (body === '') return html;
  const at = html.lastIndexOf('</body>');
  return at === -1 ? `${html}${body}` : `${html.slice(0, at)}${body}\n${html.slice(at)}`;
}
