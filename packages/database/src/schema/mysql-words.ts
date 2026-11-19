/**
 * The words of a MySQL statement that MySQL reads as code, outside its string literals and comments — lexed by MySQL's rules, which are not
 * those of SQLite and Postgres:
 *
 * - a backslash escapes the next character inside a string, so `'\''` is one string;
 * - `#` starts a comment, and `--` only when whitespace follows it (`1--1` is arithmetic);
 * - `/*! … *\/` is executed (by the server's version) and `/*+ … *\/` is an optimizer hint: a text with either is not scanned, and every
 *   word of it counts, those in its strings and comments too (a quote inside such a comment can start or end a string elsewhere);
 * - a `"…"` or `` `…` `` name is an identifier (the session runs with `ANSI_QUOTES`), so its content stays too.
 *
 * What is unclear stays code: an unterminated string or comment is read to its end as words, never skipped. Used by `schema.raw()` to find
 * the migrator's tables in a statement; it parses nothing else.
 */
export function mysqlWords(text: string): string[] {
  // `/*!` and `/*+` open text the server may read as code or skip as a comment, by its version and by where a hint may stand; a string
  // inside it can then start or end somewhere else than this scanner thinks. Without a scan, every word of the text counts.
  if (hasExecutableComment(text)) return text.match(WORD) ?? [];
  return (mysqlCode(text).match(WORD) ?? []);
}

const WORD = /[A-Za-z_][\w$]*/g;

/** Whether the text has a `/*!` or `/*+` comment anywhere (a plain test with no state, so no string can hide it). */
export function hasExecutableComment(text: string): boolean {
  return /\/\*[!+]/.test(text);
}

/** The text with its string literals and comments replaced by a space; names in quotes stay. */
function mysqlCode(text: string): string {
  let code = '';
  const end = text.length;
  let i = 0;
  while (i < end) {
    const char = text[i]!;
    if (char === "'") {
      const close = endOfString(text, i);
      // Unterminated: MySQL refuses the statement, and a guard that skips the rest would be fooled by a quote it never closed.
      if (close < 0) {
        code += text.slice(i + 1);
        break;
      }
      code += ' ';
      i = close + 1;
    } else if (char === '"' || char === '`') {
      // An identifier: its words count. Skipped as a unit so that a quote or `--` inside it does not start anything.
      const close = endOfName(text, i, char);
      if (close < 0) {
        code += text.slice(i + 1);
        break;
      }
      // Only the words of the name: a `;` or a quote in it starts nothing. Straight after a single `@` they follow it, which is the user variable `@name`.
      const named = (text.slice(i + 1, close).match(/[A-Za-z0-9_$]+/g) ?? []).join(' ');
      code += /(?<!@)@$/.test(code) ? named : ` ${named} `;
      i = close + 1;
    } else if (char === '#') {
      const newline = text.indexOf('\n', i);
      code += ' ';
      i = newline < 0 ? end : newline + 1;
    } else if (char === '-' && text[i + 1] === '-' && (i + 2 >= end || text.charCodeAt(i + 2) <= 0x20)) {
      const newline = text.indexOf('\n', i);
      code += ' ';
      i = newline < 0 ? end : newline + 1;
    } else if (char === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) {
        code += text.slice(i + 2);
        break;
      }
      code += ' ';
      i = close + 2;
    } else {
      code += char;
      i++;
    }
  }
  return code;
}

/** The index of the quote that ends the string opened at `start`, or -1. A backslash escapes the next character; a doubled quote is the same escape. */
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === "'") {
      if (text[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

/** The index of the quote that ends the name opened at `start`: no backslash escape, a doubled quote stands for itself. */
function endOfName(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== quote) continue;
    if (text[i + 1] === quote) i++;
    else return i;
  }
  return -1;
}

/** Statements that end the open transaction by themselves, by their first word (MySQL's "statements that cause an implicit commit"). */
const COMMITS = new Set([
  'create', 'alter', 'drop', 'rename', 'truncate', 'lock', 'unlock', 'grant', 'revoke', 'analyze', 'optimize', 'repair', 'begin', 'start',
  'install', 'uninstall', 'cache', 'flush', 'reset', 'purge', 'change', 'stop', 'shutdown', 'restart', 'import', 'check', 'commit', 'rollback',
]);

/**
 * In a `set` statement: the word `autocommit` or `password` that is no `@user` variable (a single `@`), whatever stands in front of it
 * (`@@`, a scope, a dot, a comment, a quote that the scan took out) and with an assignment after it (`=`, `:=`; for `password` also `for` and `to`).
 * Other words of the statement, such as a name in an expression, do not match.
 */
const SETS_AUTOCOMMIT = /(?<![\w$])(?<!(?<!@)@)autocommit[\s)]*:?=/i;
const SETS_PASSWORD = /(?<![\w$])(?<!(?<!@)@)password[\s)]*(?::?=|for\b|to\b)/i;
/** For a text that is not split (a `/*!` or `/*+` comment in it): the words anywhere count. */
const LOOSE_AUTOCOMMIT = /(?<![\w$])(?<!(?<!@)@)autocommit/i;
const LOOSE_PASSWORD = /(?<![\w$])(?<!(?<!@)@)password/i;

/**
 * Whether a MySQL statement text holds a statement that commits the open transaction by itself: the first word of each statement
 * (split at `;` outside strings and comments) is one of {@link COMMITS}, `load index`, `set autocommit` or `set … password`, `commit` and `rollback` (a data step does not steer its transaction). A text with a `/*!` or `/*+`
 * comment cannot be split reliably: any of those words anywhere counts. Unclear text counts as committing.
 */
export function mysqlCommits(text: string, unsplittable = false): boolean {
  if (unsplittable || hasExecutableComment(text)) {
    const words = (text.match(WORD) ?? []).map((word) => word.toLowerCase());
    return words.some((word) => COMMITS.has(word)) || LOOSE_AUTOCOMMIT.test(text) || (words.includes('set') && (LOOSE_PASSWORD.test(text) || words.includes('role')));
  }
  return mysqlCode(text)
    .split(';')
    .some((statement) => {
      const [first, second, third] = (statement.match(WORD) ?? []).map((word) => word.toLowerCase());
      if (first === undefined) return false;
      if (COMMITS.has(first)) return true;
      if (first === 'load') return second === 'index';
      // `set default role …` commits; `set role …` does not.
      return first === 'set' && ((second === 'default' && third === 'role') || SETS_AUTOCOMMIT.test(statement) || SETS_PASSWORD.test(statement));
    });
}
