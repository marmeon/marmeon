/**
 * The anchor of a heading, by the rule the documentation website uses for its heading ids (GitHub's): the text without its
 * markup, lower-cased, everything but letters, marks, numbers, `_`, `-` and spaces dropped, spaces turned into `-`. A heading that
 * repeats one of the page gets `-1`, `-2` … appended, so a page needs one {@link Anchors} for all of its headings, in order.
 * `docs/<page>.md#<anchor>` is a link the framework promises to keep working (docs/releases.md#stored-and-wire-formats).
 */
export class Anchors {
  readonly #taken = new Map<string, number>();

  /** The anchor of the next heading of the page, given as it is written after the `#`s. */
  next(heading: string): string {
    const base = plainHeading(heading).toLowerCase().replace(DROPPED, '').replace(/ /g, '-');
    let anchor = base;
    while (this.#taken.has(anchor)) {
      const count = (this.#taken.get(base) ?? 0) + 1;
      this.#taken.set(base, count);
      anchor = `${base}-${count}`;
    }
    this.#taken.set(anchor, 0);
    return anchor;
  }
}

/** The anchor of a heading that is alone on its page. */
export function anchorOf(heading: string): string {
  return new Anchors().next(heading);
}

const DROPPED = /[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu;

/* oxlint-disable regexp/no-super-linear-move, regexp/no-super-linear-backtracking -- the headings come from the docs and from markdown files of the app */
/** The words of a heading: images and links by their text, code spans without their backticks, emphasis and escapes resolved. */
export function plainHeading(heading: string): string {
  const text = heading.replace(/\s+#+\s*$/, '');
  // Code spans stay as they are; only the text between them has markup.
  let out = '';
  let last = 0;
  for (const span of text.matchAll(/(`+)([\s\S]*?[^`])\1(?!`)/g)) {
    out += markup(text.slice(last, span.index)) + span[2]!.replace(/^ (.*) $/, '$1');
    last = span.index + span[0].length;
  }
  return (out + markup(text.slice(last))).trim();
}

function markup(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/(^|[^\p{L}\p{N}])_+([^_]+?)_+(?![\p{L}\p{N}])/gu, '$1$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/* oxlint-enable regexp/no-super-linear-move, regexp/no-super-linear-backtracking */

/** A heading of a markdown page, in the order of the page. */
export interface Heading {
  /** The index of its line. */
  readonly line: number;
  /** The number of `#`s. */
  readonly level: number;
  /** The words, without markup. */
  readonly text: string;
  readonly anchor: string;
}

// oxlint-disable-next-line regexp/no-super-linear-backtracking -- the line comes from the docs or from a markdown file of the app
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Every ATX heading of a page (`#` to `######`) with its anchor. A line inside a fenced code block is no heading. */
export function headingsOf(markdown: string): Heading[] {
  const anchors = new Anchors();
  const headings: Heading[] = [];
  let fence: string | undefined;
  markdown.split('\n').forEach((line, index) => {
    const opening = FENCE.exec(line);
    if (fence !== undefined) {
      if (opening && opening[1]![0] === fence[0] && opening[1]!.length >= fence.length && line.trim() === opening[1]) fence = undefined;
      return;
    }
    if (opening) {
      fence = opening[1];
      return;
    }
    const heading = HEADING.exec(line);
    if (!heading) return;
    const written = heading[2] ?? '';
    headings.push({ line: index, level: heading[1]!.length, text: plainHeading(written), anchor: anchors.next(written) });
  });
  return headings;
}
