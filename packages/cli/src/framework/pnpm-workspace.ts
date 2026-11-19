import { readFileSync } from 'node:fs';

/** What the commands need to know of a `pnpm-workspace.yaml`. */
export type PnpmWorkspaceFile =
  | {
      readonly readable: true;
      /** The file has a top-level `packages` key: the directory is the root of a workspace with members. */
      readonly packages: boolean;
      /** The entries under `overrides`: their keys and values as parsed (the text between quotes for a quoted one, no comments). */
      readonly overrides: readonly { readonly key: string; readonly value: string }[];
      /** The keys under `patchedDependencies`, parsed the same way. */
      readonly patchedDependencies: readonly string[];
    }
  /** `line` is the number of the first line that is none of the allowed forms (1-based; its content is not kept). */
  | { readonly readable: false; readonly line: number };

// The only forms a line of the file may take; every other line makes it unreadable. Plain scalars cannot start with an indicator
// (`&`, `*`, `!`, `|`, `>`, `[`, `{`, `@`, `-` and a space) and hold nothing that YAML reads as a mapping (`: `). Quoted scalars have no
// backslash and no quote of their own kind inside, and the closing quote ends the token (a ` #` comment may follow).
const SCALAR = String.raw`(?![-?] )[A-Za-z0-9._/^~<=+-][A-Za-z0-9@._/^~<>=*|:+ -]*`;
const NAME = String.raw`[@A-Za-z0-9._/^~<>=*|-]+`;
const QUOTED = String.raw`'[^'\\]*'|"[^"\\]*"`;
const BLANK = /^ *$/;
const COMMENT = /^ *#/;
const PLAIN_SCALAR = new RegExp(`^${SCALAR}$`);
const QUOTED_TOKEN = new RegExp(String.raw`^(${QUOTED})(?: +#.*)?$`);
const QUOTED_KEY = new RegExp(String.raw`^(${QUOTED}):(?: (.*))?$`);
const PLAIN_KEY = new RegExp(String.raw`^(${NAME}):(?: (.*))?$`);
const TOP_KEY = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/;

/** The text of a scalar token `text` (quotes taken off), or `undefined` when it is not an allowed form. */
function scalar(text: string): string | undefined {
  if (text.startsWith("'") || text.startsWith('"')) {
    const quoted = QUOTED_TOKEN.exec(text)?.[1];
    return quoted === undefined ? undefined : quoted.slice(1, -1);
  }
  // A comment after whitespace ends a plain scalar; `#` inside one is not in the allowed characters.
  const plain = (text.includes(' #') ? text.slice(0, text.indexOf(' #')) : text).trimEnd();
  return PLAIN_SCALAR.test(plain) && !plain.includes(': ') && !plain.endsWith(':') ? plain : undefined;
}

/** What follows a colon: nothing for a key that opens a block, also when only a comment follows. */
const valueOf = (rest: string | undefined): string | undefined => (rest?.startsWith('#') ? undefined : rest);

/** A nested key and what follows its colon (`undefined` for a key that opens a block), or `undefined` when the line is not a key. */
function entryOf(body: string): { readonly key: string; readonly rest: string | undefined } | undefined {
  const quoted = QUOTED_KEY.exec(body);
  const plain = quoted ? undefined : PLAIN_KEY.exec(body);
  const match = quoted ?? plain;
  if (!match) return undefined;
  const key = quoted ? match[1]!.slice(1, -1) : match[1]!;
  return key === '<<' ? undefined : { key, rest: valueOf(match[2]) };
}

/**
 * Reads the three facts of a `pnpm-workspace.yaml` that matter here, by an allow-list: every line must be one of a few exact forms, and
 * any other line makes the file `readable: false` (with its line number). The forms: a blank line, a comment, a top-level `key:` or
 * `key: scalar`, and below a `key:` line nested lines exactly two spaces deeper (`key:` opens a deeper level, `key: scalar`, `- scalar`),
 * which may return to any open level. A document marker, flow style, an anchor, an alias, a merge key, a block scalar, a tab, an
 * escape, an odd or jumping indentation or a multi-line scalar is none of them. `overrides` and `patchedDependencies` hold one level of
 * `key: scalar` entries, `packages` a list of scalars. CRLF line ends count as LF.
 */
export function readPnpmWorkspace(file: string): PnpmWorkspaceFile {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { readable: false, line: 1 };
  }
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  // A lone CR ends a line for a YAML parser, which this reader would take for the middle of one (a comment hiding a key).
  const lone = lines.findIndex((line) => line.includes('\r'));
  if (lone !== -1) return { readable: false, line: lone + 1 };
  let section: string | undefined;
  let packages = false;
  const overrides: { key: string; value: string }[] = [];
  const patched: string[] = [];
  // The indentations of the open levels (the top level is 0), and the one a `key:` line just opened for the next line.
  let levels = [0];
  let opens: number | undefined;
  for (const [index, line] of lines.entries()) {
    const fail = { readable: false, line: index + 1 } as const;
    if (BLANK.test(line) || COMMENT.test(line)) continue;
    // Spaces only: a tab is part of the body, which no form allows.
    let indent = 0;
    while (line[indent] === ' ') indent++;
    const body = line.slice(indent);
    if (opens === indent) levels.push(indent);
    else if (!levels.includes(indent)) return fail;
    levels = levels.slice(0, levels.indexOf(indent) + 1);
    opens = undefined;
    if (indent === 0) {
      const top = TOP_KEY.exec(line);
      if (!top) return fail;
      section = top[1]!;
      if (section === 'packages') packages = true;
      const block = ['overrides', 'patchedDependencies', 'packages'].includes(section);
      // A section opens a block: an inline value would be another form (flow, alias, a scalar where a mapping belongs).
      const rest = valueOf(top[2]);
      if (rest !== undefined && (block || scalar(rest) === undefined)) return fail;
      if (rest === undefined) opens = 2;
      continue;
    }
    if (section === undefined) return fail;
    const flat = section === 'overrides' || section === 'patchedDependencies';
    if (body.startsWith('- ')) {
      if (flat || scalar(body.slice(2)) === undefined) return fail;
      continue;
    }
    if (section === 'packages') return fail;
    const entry = entryOf(body);
    if (!entry) return fail;
    if (entry.rest === undefined) {
      // A key without a value opens a level, except where only entries with scalars are allowed.
      if (flat) return fail;
      opens = indent + 2;
      continue;
    }
    const value = scalar(entry.rest);
    if (value === undefined) return fail;
    if (flat && indent !== 2) return fail;
    if (section === 'overrides') overrides.push({ key: entry.key, value });
    if (section === 'patchedDependencies') patched.push(entry.key);
  }
  return { readable: true, packages, overrides, patchedDependencies: patched };
}
