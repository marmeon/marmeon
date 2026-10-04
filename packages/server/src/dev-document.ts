/**
 * Development only (E115): HTML the Vite dev renderer adds to every document it renders, just before `</body>` — outside
 * the app's root element, so hydration never sees it, and never in a client chunk: the devtools' link to
 * `/_bespoke/devtools` (W7 step 8; the in-page bar of step 9 hangs here too). Bound by the `ServerServiceProvider` only
 * with `NODE_ENV=development`; the production renderer never reads it.
 *
 * ```ts
 * if (app.container.has(DevDocument)) app.container.make(DevDocument).add('<a href="/_bespoke/devtools">Devtools</a>');
 * ```
 *
 * What is added is trusted markup (a package's own, never anything from a request).
 */
export class DevDocument {
  readonly #body: string[] = [];

  /** Adds `markup` to the end of every development document's body. */
  add(markup: string): this {
    this.#body.push(markup);
    return this;
  }

  /** What goes before `</body>`. */
  get body(): string {
    return this.#body.join('\n');
  }
}

/** The template with `body` before its `</body>` (or at its end without one). */
export function withDevBody(template: string, body: string): string {
  if (body === '') return template;
  const at = template.lastIndexOf('</body>');
  return at === -1 ? `${template}${body}` : `${template.slice(0, at)}${body}\n${template.slice(at)}`;
}
