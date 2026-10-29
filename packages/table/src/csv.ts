/**
 * CSV for exports (RFC 4180): every field quoted, quotes doubled, lines ended by CRLF — and **formula injection** escaped (OWASP
 * "CSV Injection"): a text cell that starts with `=`, `+`, `-`, `@`, a tab, a carriage return or a line feed gets a `'` in front, so a
 * spreadsheet shows it as text instead of running it (`=HYPERLINK(…)`, `@SUM(…)`, `-2+3`). Numbers stay numbers (`-5` is no formula), and so does a decimal that arrives as text
 * (`-12.50`): a text that is nothing but an optional minus, digits and one decimal point is no formula. An exponent (`-2E3`) or
 * anything after the digits is escaped. A text that already starts with `'` before such a character gets one more `'`, so
 * {@link unescapeCsvCell} gives every exported text back exactly as it was.
 */

/** Byte order mark: spreadsheets read the file as UTF-8 (umlauts) only with it. */
export const CSV_BOM = '﻿';

/** The characters a cell must not start with — a spreadsheet would read it as a formula (OWASP). */
const FORMULA_START = /^[=+\-@\t\r\n]/;

/** Quotes in front of a formula start: an exported text that began like this gets one more `'`, so the escape stays undoable. */
const QUOTED_FORMULA_START = /^'+[=+\-@\t\r\n]/;

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
  if (QUOTED_FORMULA_START.test(text)) return `'${text}`;
  return FORMULA_START.test(text) && !PLAIN_DECIMAL.test(text) ? `'${text}` : text;
}

/**
 * Reads a cell of an export back as it was before it was written. The argument is the cell's text as a CSV reader returns it, without
 * the outer quotes and with `""` already turned into `"`. Removes the one `'` that the export put in front of a text that
 * began with `=`, `+`, `-`, `@`, a tab, a carriage return or a line feed, or with `'` (once or more) and one of them. Any other
 * text stays as it is. The result is plain text, not a formula: a reader must never run it. See docs/tables.md#exports.
 */
export function unescapeCsvCell(text: string): string {
  return QUOTED_FORMULA_START.test(text) ? text.slice(1) : text;
}

/** A line of cells, ended by CRLF. */
export function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
