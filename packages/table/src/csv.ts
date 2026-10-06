/**
 * CSV for exports (RFC 4180): every field quoted, quotes doubled, lines ended by CRLF — and **formula injection** escaped (OWASP
 * "CSV Injection"): a text cell that starts with `=`, `+`, `-`, `@`, a tab, a carriage return or a line feed gets a `'` in front, so a
 * spreadsheet shows it as text instead of running it (`=HYPERLINK(…)`, `@SUM(…)`, `-2+3`). Numbers stay numbers (`-5` is no formula).
 */

/** Byte order mark: spreadsheets read the file as UTF-8 (umlauts) only with it. */
export const CSV_BOM = '﻿';

/** The characters a cell must not start with — a spreadsheet would read it as a formula (OWASP). */
const FORMULA_START = /^[=+\-@\t\r\n]/;

/** One cell as CSV text — quoted, escaped. */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'number' || typeof value === 'bigint') text = Number.isFinite(Number(value)) || typeof value === 'bigint' ? String(value) : '';
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'string') text = FORMULA_START.test(value) ? `'${value}` : value;
  else text = escapeText(JSON.stringify(value));
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeText(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** A line of cells, ended by CRLF. */
export function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
