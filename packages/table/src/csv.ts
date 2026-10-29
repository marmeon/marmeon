/**
 * CSV for exports (RFC 4180): every field quoted, quotes doubled, lines ended by CRLF — and **formula injection** escaped (OWASP
 * "CSV Injection"): a text cell that starts with `=`, `+`, `-`, `@`, a tab, a carriage return or a line feed — also after spaces or
 * invisible characters, or as a full-width `＝`, `＋`, `－`, `＠` — gets a `'` in front, so a spreadsheet shows it as text instead of
 * running it (`=HYPERLINK(…)`, `@SUM(…)`, `-2+3`). Numbers stay numbers (`-5` is no formula), and so does a decimal that arrives as text
 * (`-12.50`): a text that is nothing but an optional minus, digits and one decimal point is no formula. An exponent (`-2E3`) or
 * anything after the digits is escaped. A text that already starts with `'` before such a character gets one more `'`, so
 * {@link unescapeCsvCell} gives every exported text back exactly as it was.
 */

import type { CsvDelimiter } from './csv-read.ts';

/** Byte order mark: spreadsheets read the file as UTF-8 (umlauts) only with it. */
export const CSV_BOM = '﻿';

/**
 * What a spreadsheet may skip in front of a formula: white space, control and format characters, and the default-ignorable code
 * points (NBSP, U+3000, byte order mark, zero-width characters, LRM/RLM and the other bidi controls, soft hyphen, variation
 * selectors, …). No vendor documents which of them it skips, and a `'` too many costs a visible character while a missing one
 * runs a formula, so the set is wide. Tab, carriage return and line feed are left out: they are formula starts themselves.
 */
const IGNORABLE = /^(?:(?![\t\r\n])[\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}])*/u;

const FORMULA_SIGNS = new Set(['=', '+', '-', '@', '\u2212']);

/**
 * Whether a spreadsheet may read the text as a formula: after the ignorable characters comes a tab, a carriage return, a line feed
 * or a sign that folds to `=`, `+`, `-` or `@`. NFKC folds the full-width forms (`＝`, `＋`, `－`, `＠`), the small forms and the super- and
 * subscript `=` and `+` to ASCII (the super- and subscript minus fold to U+2212, which counts as a minus too); it runs on that one code point only, never on the text.
 */
function formulaLike(text: string): boolean {
  const rest = text.slice(IGNORABLE.exec(text)?.[0].length ?? 0);
  const first = String.fromCodePoint(rest.codePointAt(0) ?? 0x20);
  return first === '\t' || first === '\r' || first === '\n' || FORMULA_SIGNS.has(first.normalize('NFKC'));
}

/** Quotes in front of a formula: an exported text that began like this gets one more `'`, so the escape stays undoable. */
function quotedFormula(text: string): boolean {
  const quotes = /^'+/.exec(text);
  return quotes !== null && formulaLike(text.slice(quotes[0].length));
}

/** A decimal as text (`-12.50`): digits only, so a spreadsheet reads a number and never runs it. */
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/** One cell as CSV text — quoted, escaped. */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'number' || typeof value === 'bigint') text = Number.isFinite(Number(value)) || typeof value === 'bigint' ? String(value) : '';
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'string') text = escapeText(value);
  else text = escapeText(JSON.stringify(value));
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeText(text: string): string {
  return quotedFormula(text) || (formulaLike(text) && !PLAIN_DECIMAL.test(text)) ? `'${text}` : text;
}

/**
 * Reads a cell of an export back as it was before it was written. The argument is the cell's text as a CSV reader returns it, without
 * the outer quotes and with `""` already turned into `"`. Removes the one `'` that the export put in front of a text that
 * began like a formula (see the module comment: also behind spaces or invisible characters, or full-width), or with `'` (once or
 * more) and such a start. Any other
 * text stays as it is. The result is plain text, not a formula: a reader must never run it. See docs/tables.md#exports.
 */
export function unescapeCsvCell(text: string): string {
  return quotedFormula(text) ? text.slice(1) : text;
}

/** The separators an export may use — the ones {@link readCsv} detects: nothing else is a delimiter, so none can be a quote, a line break or a formula sign. */
export const CSV_DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t'];

/** Whether `value` is one of the separators an export may use. */
export function isCsvDelimiter(value: unknown): value is CsvDelimiter {
  return typeof value === 'string' && (CSV_DELIMITERS as readonly string[]).includes(value);
}

/** A line of cells, ended by CRLF. Every cell is quoted, so a separator inside a cell is no separator. */
export function csvLine(values: readonly unknown[], delimiter: CsvDelimiter = ','): string {
  if (!isCsvDelimiter(delimiter)) throw new TypeError(`csvLine(): the delimiter is "," ";" or a tab, not ${JSON.stringify(delimiter)}.`);
  return `${values.map(csvCell).join(delimiter)}\r\n`;
}
