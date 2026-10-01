/** Turns a page's title into the document title, e.g. `(title) => title ? `${title} — Shop` : 'Shop'`. */
export type TitleTemplate = (title: string) => string;

export const defaultTitle: TitleTemplate = (title) => title;

/**
 * The titles of the mounted head components (layouts and page) — the one rendered last wins, like on the server.
 * When the page's goes away and nobody else has one, the document title falls back to `template('')`: a page
 * without a title does not keep the title of the page before it. An adapter's `<Head>` takes an `order()` when it
 * mounts, `set()`s its title and `delete()`s it when it unmounts.
 */
export class TitleRegistry {
  readonly #titles = new Map<number, string>();
  readonly #template: TitleTemplate;
  readonly #document: Pick<Document, 'title'>;
  #next = 0;

  constructor(template: TitleTemplate, doc: Pick<Document, 'title'> = document) {
    this.#template = template;
    this.#document = doc;
  }

  /** A number in render order — taken once, when a head component mounts. */
  order(): number {
    return this.#next++;
  }

  set(order: number, title: string): void {
    this.#titles.set(order, title);
    this.#apply();
  }

  delete(order: number): void {
    if (this.#titles.delete(order)) this.#apply();
  }

  #apply(): void {
    let last: number | undefined;
    for (const order of this.#titles.keys()) if (last === undefined || order > last) last = order;
    this.#document.title = this.#template(last === undefined ? '' : this.#titles.get(last)!);
  }
}
