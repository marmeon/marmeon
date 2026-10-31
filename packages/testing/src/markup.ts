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
  'center', 'dd', 'dir', 'dt', 'li', 'listing', 'plaintext', 'summary', 'xmp',
]);

/** Elements that end the search for an open `<li>`, `<dt>` or `<dd>`: the spec's "special" elements, except `<address>`, `<div>` and `<p>`. */
const SPECIAL = new Set([
  'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound', 'blockquote', 'body', 'br', 'button', 'caption', 'center', 'col', 'colgroup',
  'dd', 'details', 'dir', 'dl', 'dt', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'iframe', 'img', 'input', 'li', 'link', 'listing', 'main', 'marquee', 'menu', 'meta', 'nav',
  'noembed', 'noframes', 'noscript', 'object', 'ol', 'param', 'plaintext', 'pre', 'script', 'search', 'section', 'select', 'source', 'style',
  'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul', 'wbr', 'xmp',
]);
/** Elements a search for an open `<p>`, `<a>` or `<button>` stops at: what the parser treats as a new scope (foreign content included). */
const SCOPE = new Set(['applet', 'caption', 'html', 'marquee', 'math', 'object', 'svg', 'table', 'td', 'template', 'th']);
const TABLE_PARTS = new Set(['caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);
const TABLE_SECTIONS = new Set(['table', 'tbody', 'tfoot', 'thead']);

/**
 * Where the browser's HTML parser would build another tree than the markup says, so React finds other elements than it rendered
 * and the page does not hydrate. Undefined when the markup is parsed as written. Checked:
 *
 * - a `<form>`, `<div>`, `<ul>`, `<table>` and the other blocks that close a `<p>`, inside a `<p>`;
 * - a `<form>` inside a `<form>`, an `<a>` inside an `<a>`, a `<button>` inside a `<button>`, an `<option>` inside an `<option>`;
 * - an `<li>` inside an `<li>`, a `<dt>` or `<dd>` inside a `<dt>` or `<dd>`, with nothing but a `<div>`, a `<p>` or inline elements between them;
 * - table content outside a `<table>`, a `<tr>` right inside a `<table>` (the parser adds a `<tbody>`), a `<col>` right inside one (a `<colgroup>`), a cell right inside a section.
 *
 * Not checked: other content models, such as a block inside an `<a>` (the parser keeps it) or a `<select>` with other children.
 * See `docs/testing-pages.md#server-rendering`.
 */
export function misnested(html: string): string | undefined {
  const open: string[] = [];
  const tag = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    if (match[2] === undefined) continue;
    const name = match[2]!.toLowerCase();
    if (match[1]) {
      const at = open.lastIndexOf(name);
      if (at >= 0) open.length = at;
      continue;
    }
    const problem = nesting(name, open);
    if (problem !== undefined) return problem;
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

/** What the parser does with the start tag `name` when `open` is the stack of open elements. */
function nesting(name: string, open: readonly string[]): string | undefined {
  if (CLOSES_P.has(name) && openInScope(open, 'p', true)) return `<${name}> inside <p> (${path(open)}): the browser closes the <p> first`;
  if (name === 'form' && open.lastIndexOf('form') > open.lastIndexOf('template')) return `<form> inside <form> (${path(open)}): the browser drops the inner one`;
  if ((name === 'a' || name === 'button') && openInScope(open, name, false)) {
    return `<${name}> inside <${name}> (${path(open)}): the browser closes the first <${name}>`;
  }
  if (name === 'option' && open.lastIndexOf('option') > open.lastIndexOf('template')) return `<option> inside <option> (${path(open)}): the browser closes the first <option>`;
  if (name === 'li' && closesItem(open, ['li'])) return `<li> inside <li> (${path(open)}): the browser closes the first <li>`;
  if ((name === 'dt' || name === 'dd') && closesItem(open, ['dt', 'dd'])) {
    return `<${name}> inside <dt> or <dd> (${path(open)}): the browser closes the first one`;
  }
  if (TABLE_PARTS.has(name) && !open.includes('table') && !open.includes('template')) return `<${name}> outside a <table> (${path(open)}): the browser drops it`;
  const parent = open.at(-1);
  if (name === 'col' && parent === 'table') return `<col> directly inside <table> (${path(open)}): the browser adds a <colgroup>`;
  if (name === 'tr' && parent === 'table') return `<tr> directly inside <table> (${path(open)}): the browser adds a <tbody>`;
  if ((name === 'td' || name === 'th') && parent !== undefined && TABLE_SECTIONS.has(parent)) {
    return `<${name}> directly inside <${parent}> (${path(open)}): the browser adds a <tr>`;
  }
  return undefined;
}

/** `name` is open with no scope boundary between it and the new element — for `<p>`, a `<button>` is one too. */
function openInScope(open: readonly string[], name: string, buttonScope: boolean): boolean {
  for (let at = open.length - 1; at >= 0; at--) {
    if (open[at] === name) return true;
    if (SCOPE.has(open[at]!) || (buttonScope && open[at] === 'button')) return false;
  }
  return false;
}

/** An element of `names` is open with no special element (`<ul>`, `<dl>`, `<section>`, …) between it and the new one. */
function closesItem(open: readonly string[], names: readonly string[]): boolean {
  for (let at = open.length - 1; at >= 0; at--) {
    if (names.includes(open[at]!)) return true;
    if (SPECIAL.has(open[at]!)) return false;
  }
  return false;
}

function path(open: readonly string[]): string {
  return open.slice(-4).join(' > ');
}
