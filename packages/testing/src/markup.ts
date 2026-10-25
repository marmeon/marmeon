import { AssertionError } from 'node:assert';

/** What `app.placeholder(route, instant)` renders: the markup of an instant visit's placeholder, layouts included. */
export class TestMarkup {
  /** The rendered HTML. */
  readonly html: string;

  /**
   * Use `app.placeholder()`.
   *
   * @internal
   */
  constructor(html: string) {
    this.html = html;
  }

  assertSee(text: string): this {
    if (!this.html.includes(text)) this.#fail(`Expected to see "${text}"`);
    return this;
  }

  assertDontSee(text: string): this {
    if (this.html.includes(text)) this.#fail(`Expected not to see "${text}"`);
    return this;
  }

  #fail(message: string): never {
    const excerpt = this.html.length > 600 ? `${this.html.slice(0, 600)}…` : this.html;
    throw new AssertionError({ message: `${message}\n  placeholder\n  ${excerpt}` });
  }
}

/** Elements without content: never on the stack. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements whose content is text, not markup. */
const RAW = new Set(['script', 'style', 'textarea', 'title']);
/** Start tags before which the HTML parser closes an open `<p>` (the spec's "close a p element"). */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul',
]);

/**
 * Where the browser's HTML parser would build another tree than the markup says — a `<form>` (a `<Link>` that sends) or a `<div>`
 * inside a `<p>`: the parser closes the `<p>` first; a `<form>` inside a `<form>`: the parser drops it. React then finds other
 * elements than it rendered and the page does not hydrate. Undefined when the markup is parsed as written.
 */
export function misnested(html: string): string | undefined {
  const open: string[] = [];
  const tag = /<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    const name = match[2]!.toLowerCase();
    if (match[1]) {
      const at = open.lastIndexOf(name);
      if (at >= 0) open.length = at;
      continue;
    }
    if (CLOSES_P.has(name) && open.includes('p')) return `<${name}> inside <p> (${path(open)}): the browser closes the <p> first`;
    if (name === 'form' && open.includes('form')) return `<form> inside <form> (${path(open)}): the browser drops the inner one`;
    if (VOID.has(name) || match[3]) continue;
    if (RAW.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, tag.lastIndex);
      tag.lastIndex = end < 0 ? html.length : end;
      continue;
    }
    open.push(name);
  }
  return undefined;
}

function path(open: readonly string[]): string {
  return open.slice(-4).join(' > ');
}
