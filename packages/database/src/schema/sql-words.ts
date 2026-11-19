import { LOCK_TABLE, MIGRATIONS_TABLE } from '../migration-state.ts';

/**
 * The words of an SQLite or Postgres statement that the server reads as code, outside its string literals and comments — scanned in one
 * pass, with the state each of them has:
 *
 * - `'…'` is a string, a doubled quote inside it is one quote. On Postgres `E'…'` also takes a backslash as an escape; a plain string with a
 *   backslash in it reads differently with `standard_conforming_strings` off, so from there on the rest of the text counts as words. SQLite
 *   takes a `'…'` string for a name where a name is expected (`delete from 'migrations'`), so its words count too ({@link sqlWords}).
 * - `"…"` (both), `[…]` and `` `…` `` (SQLite) are names: skipped as a unit, so that a quote or `--` in a name starts nothing, and only their
 *   words are kept (`"migrations"` is the table; a `;` in a name ends no statement).
 * - `-- …` runs to the end of the line (Postgres ends it at `\r` too), `/* … *\/` to its end: SQLite at the first `*\/`, Postgres at the one
 *   that closes the level it opened (they nest).
 * - Postgres `$$ … $$` and `$tag$ … $tag$` hold text that may be code (`do $$ begin … end $$`): its words are kept, and nothing in it starts a
 *   string or a comment. Every character from U+0080 on is part of a name there.
 * - SQLite reads `$a(…)`, `@a(…)`, `:a(…)` and `#a(…)` as one variable token up to the `)` or a space, tab, newline, vertical tab, form feed or
 *   carriage return (no other space ends it), quotes inside it included.
 *
 * Whatever has no end (a string, a name, a comment, a dollar quote) counts to the end of the text as words. The result is the text with strings
 * and comments replaced by a space, so it can be cut into words and statements; it parses nothing else.
 */
export type SqlDialect = 'sqlite' | 'pgsql';

/** A character that can be part of a name: a letter, a digit, `_`, `$`, or anything from U+0080 on (Postgres counts every one of those as a letter). */
const isNameChar = (char: string | undefined): boolean => char !== undefined && (/[\w$]/.test(char) || char.charCodeAt(0) >= 0x80);

const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y;

function sqlCode(text: string, dialect: SqlDialect, stringWords: boolean, dollarWords = true): { code: string; tail: string } {
  let code = '';
  /** From where the text could not be told: it is no statement of its own, and every word of it counts. */
  let tail = '';
  const end = text.length;
  const postgres = dialect === 'pgsql';
  let i = 0;
  /** What is left of the text, as it is, when a construct cannot be told. */
  const rest = (from: number): void => {
    tail = text.slice(from);
    i = end;
  };
  while (i < end) {
    const char = text[i]!;
    if (char === "'") {
      const escapes = postgres && /[eE]/.test(text[i - 1] ?? '') && !isNameChar(text[i - 2]);
      const close = endOfString(text, i, escapes);
      // A backslash in a plain Postgres string: whether it escapes depends on a setting, so the text after the opening quote is read as words.
      if (close < 0 || (postgres && !escapes && text.slice(i, close).includes('\\'))) rest(i + 1);
      else {
        code += stringWords ? ` ${namedWords(text.slice(i + 1, close))} ` : ' ';
        i = close + 1;
      }
    } else if (char === '"' || (!postgres && (char === '`' || char === '['))) {
      const close = endOfName(text, i, char === '[' ? ']' : char);
      if (close < 0) rest(i + 1);
      else {
        const content = text.slice(i + 1, close);
        // Postgres `U&"…"` spells a name with escapes (`U&"migr\0061tions"` is `migrations`): decoded, or, where it cannot be told, taken for the tables of the migrator.
        code += postgres && char === '"' && /^u&$/i.test(text.slice(i - 2, i)) && !isNameChar(text[i - 3]) ? ` ${unicodeName(content, text.slice(close + 1))} ` : ` ${namedWords(content)} `;
        i = close + 1;
      }
    } else if (char === '-' && text[i + 1] === '-') {
      const newline = text.indexOf('\n', i);
      const carriage = postgres ? text.indexOf('\r', i) : -1;
      const stop = newline < 0 ? carriage : carriage < 0 ? newline : Math.min(newline, carriage);
      code += ' ';
      i = stop < 0 ? end : stop + 1;
    } else if (char === '/' && text[i + 1] === '*') {
      const close = endOfComment(text, i, postgres);
      if (close < 0) rest(i + 2);
      else {
        code += ' ';
        i = close;
      }
    } else if (postgres && char === '$' && !isNameChar(text[i - 1])) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(text)?.[0];
      if (tag === undefined) {
        code += char;
        i++;
      } else {
        const close = text.indexOf(tag, i + tag.length);
        if (close < 0) rest(i + tag.length);
        else {
          // For the words the text counts; for the statements it is one piece that no `;` in it cuts.
          code += dollarWords ? ` ${text.slice(i + tag.length, close)} ` : ' ';
          i = close + tag.length;
        }
      }
    } else if (!postgres && (char === '@' || char === ':' || char === '#' || (char === '$' && !isNameChar(text[i - 1]))) && variableEnd(text, i) > i) {
      // One token for the tokenizer, whatever quotes stand in it: its words stay.
      const stop = variableEnd(text, i);
      code += ` ${text.slice(i, stop)} `;
      i = stop;
    } else {
      code += char;
      i++;
    }
  }
  return { code, tail };
}

/** Whether the text, after spaces and comments, goes on with the word `UESCAPE`. */
function startsWithUescape(text: string): boolean {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] === '-' && text[i + 1] === '-') {
      const stop = text.slice(i).search(/[\n\r]/);
      // A comment without an end: the clause cannot be ruled out.
      if (stop < 0) return true;
      i += stop;
    } else if (text[i] === '/' && text[i + 1] === '*') {
      // Postgres nests block comments, so `/* /* */ */` is one comment.
      const close = endOfComment(text, i, true);
      if (close < 0) return true;
      i = close;
    } else break;
  }
  return /^uescape(?![\w$])/i.test(text.slice(i, i + 8));
}

/** What a name that cannot be read counts as: the migrator's tables, so that the guard of their names refuses it. */
const UNKNOWN_NAME = `${MIGRATIONS_TABLE} ${LOCK_TABLE}`;

/**
 * The words of the name in `U&"…"`: `\XXXX` and `\+XXXXXX` are code points, `\\` is a backslash. A `UESCAPE` clause (another escape character), a
 * code point that is no character or an escape that is not one cannot be told here: the name then counts as {@link UNKNOWN_NAME}.
 */
function unicodeName(content: string, after: string): string {
  if (startsWithUescape(after)) return UNKNOWN_NAME;
  let name = '';
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '\\') {
      name += content[i];
      continue;
    }
    if (content[i + 1] === '\\') {
      name += '\\';
      i++;
      continue;
    }
    const long = content[i + 1] === '+';
    const digits = content.slice(i + (long ? 2 : 1), i + (long ? 8 : 5));
    const code = Number.parseInt(digits, 16);
    if (!new RegExp(`^[0-9A-Fa-f]{${long ? 6 : 4}}$`).test(digits) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return UNKNOWN_NAME;
    name += String.fromCodePoint(code);
    i += long ? 7 : 4;
  }
  return namedWords(name);
}

/** A name or string content as its words only. */
const namedWords = (content: string): string => (content.match(/[A-Za-z0-9_$]+/g) ?? []).join(' ');

/** Where an SQLite variable that begins at `start` (`$`, `@`, `:` or `#`) ends, or `start` when it is none: a name, and after it `(…)` up to the `)` or a space, tab, newline, vertical tab, form feed or carriage return (no other space ends it). */
function variableEnd(text: string, start: number): number {
  let i = start + 1;
  const first = i;
  for (; i < text.length; i++) {
    if (text[i] === ':' && text[i + 1] === ':') i++;
    else if (!isNameChar(text[i])) break;
  }
  if (i === first) return start;
  if (text[i] === '(') {
    for (i++; i < text.length && text[i] !== ')' && !/[ \t\n\v\f\r]/.test(text[i]!); i++);
    if (text[i] === ')') i++;
  }
  return i;
}

/** The index after the comment that begins at `start`, or -1: at the first `*\/`, and on Postgres at the one that closes the level it opened. */
function endOfComment(text: string, start: number, nests: boolean): number {
  let depth = 1;
  for (let i = start + 2; i < text.length - 1; i++) {
    if (nests && text[i] === '/' && text[i + 1] === '*') {
      depth++;
      i++;
    } else if (text[i] === '*' && text[i + 1] === '/') {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const WORD = /[A-Za-z_][\w$]*/g;

/** The words of the statement text outside its strings and comments; on SQLite those of its `'…'` strings too, which it may read as names. */
export function sqlWords(text: string, dialect: SqlDialect): string[] {
  const { code, tail } = sqlCode(text, dialect, dialect === 'sqlite');
  return `${code} ${tail}`.match(WORD) ?? [];
}

/** Whether a statement of the text begins with `create`, `alter`, `drop` or `do` (a block of Postgres code), by the words that {@link sqlCode} leaves. */
export function sqlChangesSchema(text: string, dialect: SqlDialect): boolean {
  const { code, tail } = sqlCode(text, dialect, false, false);
  // The part that could not be told is not cut into statements (a comment before the next one would become its first word): any such word counts.
  return /\b(?:create|alter|drop|do)\b/i.test(tail) || code.split(';').some((statement) => /^(?:create|alter|drop|do)$/i.test(statement.match(WORD)?.[0] ?? ''));
}

/** The index of the quote that ends the string opened at `start`, or -1. */
function endOfString(text: string, start: number, backslash: boolean): number {
  for (let i = start + 1; i < text.length; i++) {
    if (backslash && text[i] === '\\') i++;
    else if (text[i] === "'") {
      if (text[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

/** The index of the character that ends the name opened at `start` (`close` is its closing character); a doubled one stands for itself, except in `[…]`. */
function endOfName(text: string, start: number, close: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== close) continue;
    if (close !== ']' && text[i + 1] === close) i++;
    else return i;
  }
  return -1;
}
