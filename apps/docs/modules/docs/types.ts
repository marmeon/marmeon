/**
 * A rendered page of the docs as data (no HTML string): an element is `{ t: tag, a: attributes, c: children }` (short keys —
 * a page has thousands), text is a string, and a highlighted code block is `{ html }` — markup the server's highlighter made
 * from escaped text, nothing of the file. Internal links carry `data-internal` (the view renders them as `<Link prefetch>`).
 */
export type DocNode = string | DocElement | DocCode;
export interface DocElement {
  readonly t: string;
  readonly a?: Readonly<Record<string, string>>;
  readonly c?: readonly DocNode[];
}
export interface DocCode {
  readonly html: string;
}

/** An entry of a page's table of contents (its H2 and H3). */
export interface TocEntry {
  readonly depth: number;
  readonly text: string;
  readonly id: string;
}
