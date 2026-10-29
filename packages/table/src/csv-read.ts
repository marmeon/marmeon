import { err, ok, type Result } from '@marmeon/core';
import { unescapeCsvCell } from './csv.ts';

/** A text encoding {@link readCsv} decodes. */
export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/** A field separator {@link readCsv} knows. */
export type CsvDelimiter = ',' | ';' | '\t';

/** What {@link readCsv} accepts. */
export interface ReadCsvOptions {
  /** The encoding. Default: detected, a byte order mark first, then strict UTF-8, otherwise `windows-1252`. A byte order mark that says otherwise is `not-text`. */
  readonly encoding?: CsvEncoding;
  /** The separator. Default: the most frequent of `,` `;` and a tab in the header, outside quotes; of those that keep every early row at the header's width, the first of tab, `;`, `,`. */
  readonly delimiter?: CsvDelimiter;
  /** Most bytes of the file. Default 5 MB. */
  readonly maxBytes?: number;
  /** Most rows below the header. Default 10000. */
  readonly maxRows?: number;
  /** Most columns in a row. Default 100. */
  readonly maxColumns?: number;
  /** Most characters of one cell. Default 10000. */
  readonly maxCellLength?: number;
  /** Undo the export's formula escape in the headers and cells with `unescapeCsvCell()`. Default `false`. */
  readonly unescape?: boolean;
}

/** The file as text: the first row as `headers`, the others as `rows`, every row as wide as the headers. */
export interface CsvTable {
  readonly headers: string[];
  readonly rows: string[][];
  /** The separator that was used. */
  readonly delimiter: CsvDelimiter;
  /** The encoding that was used. */
  readonly encoding: CsvEncoding;
}

/**
 * Why a file was not read. `line` is the physical line of the file, counted from 1, blank lines and line breaks inside quotes
 * included: where the row, the cell or the quote starts.
 */
export type CsvReadError =
  | { readonly kind: 'too-large'; readonly limit: number; readonly message: string }
  | { readonly kind: 'cell-too-long'; readonly limit: number; readonly line: number; readonly message: string }
  | { readonly kind: 'too-many-rows'; readonly limit: number; readonly line: number; readonly message: string }
  | { readonly kind: 'too-many-columns'; readonly limit: number; readonly line: number; readonly message: string }
  | { readonly kind: 'row-length'; readonly expected: number; readonly actual: number; readonly line: number; readonly message: string }
  | { readonly kind: 'unclosed-quote'; readonly line: number; readonly message: string }
  | { readonly kind: 'not-text'; readonly message: string };

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const QUOTE = 34;
const LF = 10;
const CR = 13;

/**
 * Reads a CSV file (RFC 4180) from its bytes — a spreadsheet's export, with its encoding, separator and byte order mark found
 * by itself — into text rows, within limits. A file that breaks a limit, has a row of another width than the header, or is no
 * text is an `err`, never a throw. A row whose cells are all empty is skipped. The values are only read, never run: a cell that
 * starts with `=` is plain text here. See docs/tables.md#importing-a-csv-file.
 *
 * ```ts
 * const csv = readCsv(await readFile(path), { unescape: true });
 * if (!csv.ok) return this.redirect().back().withErrors({ file: [csv.error.message] });
 * ```
 */
export function readCsv(bytes: Uint8Array, options: ReadCsvOptions = {}): Result<CsvTable, CsvReadError> {
  const maxBytes = limitOf('maxBytes', options.maxBytes, DEFAULT_MAX_BYTES);
  const maxRows = limitOf('maxRows', options.maxRows, 10_000);
  const maxColumns = limitOf('maxColumns', options.maxColumns, 100);
  const maxCellLength = limitOf('maxCellLength', options.maxCellLength, 10_000);

  if (bytes.length > maxBytes) return err({ kind: 'too-large', limit: maxBytes, message: `The file is larger than ${maxBytes} bytes.` });

  const decoded = decode(bytes, options.encoding);
  if (!decoded.ok) return decoded;
  const { text, encoding } = decoded.value;

  const delimiter = options.delimiter ?? detectDelimiter(text);
  const separator = delimiter.charCodeAt(0);
  const unescape = options.unescape === true;
  const length = text.length;
  const records: string[][] = [];

  let i = 0;
  let line = 1;
  while (i < length) {
    const recordLine = line;
    const record: string[] = [];
    // Cells are cut out of the text with slice(), never built character by character: a long file stays one text plus small
    // slices, not a rope of one-character strings.
    for (;;) {
      const cellLine = line;
      let cell: string;
      if (text.charCodeAt(i) === QUOTE) {
        const parts: string[] = [];
        let size = 0;
        i++;
        let from = i;
        for (;;) {
          if (i >= length) return err({ kind: 'unclosed-quote', line: cellLine, message: `The quote opened in line ${cellLine} is never closed.` });
          const code = text.charCodeAt(i);
          if (code === QUOTE) {
            if (text.charCodeAt(i + 1) === QUOTE) {
              parts.push(text.slice(from, i + 1));
              size += i + 1 - from;
              i += 2;
              from = i;
            } else {
              parts.push(text.slice(from, i));
              size += i - from;
              i++;
              break;
            }
          } else {
            if (code === LF || (code === CR && text.charCodeAt(i + 1) !== LF)) line++;
            i++;
          }
          if (size + i - from > maxCellLength) return tooLong(maxCellLength, cellLine);
        }
        // Text after the closing quote belongs to the cell, as lenient readers have it.
        from = i;
        while (i < length) {
          const code = text.charCodeAt(i);
          if (code === separator || code === LF || code === CR) break;
          i++;
        }
        parts.push(text.slice(from, i));
        size += i - from;
        if (size > maxCellLength) return tooLong(maxCellLength, cellLine);
        cell = parts.length === 1 ? parts[0]! : parts.join('');
      } else {
        const from = i;
        while (i < length) {
          const code = text.charCodeAt(i);
          if (code === separator || code === LF || code === CR) break;
          i++;
          if (i - from > maxCellLength) return tooLong(maxCellLength, cellLine);
        }
        cell = text.slice(from, i);
      }
      record.push(cell);
      if (record.length > maxColumns) return err({ kind: 'too-many-columns', limit: maxColumns, line: recordLine, message: `Line ${recordLine} has more than ${maxColumns} columns.` });
      if (i < length && text.charCodeAt(i) === separator) {
        i++;
        continue;
      }
      break;
    }
    if (i < length) {
      if (text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF) i++;
      i++;
      line++;
    }

    if (record.every((cell) => cell === '')) continue; // a blank line, or Excel's row of bare separators
    const first = records[0];
    if (first !== undefined) {
      if (records.length > maxRows) return err({ kind: 'too-many-rows', limit: maxRows, line: recordLine, message: `The file has more than ${maxRows} rows.` });
      if (record.length !== first.length) {
        return err({ kind: 'row-length', expected: first.length, actual: record.length, line: recordLine, message: `Line ${recordLine} has ${record.length} columns, the header has ${first.length}.` });
      }
    }
    records.push(record);
  }

  const [first = [], ...rest] = records;
  const clean = (row: string[]): string[] => (unescape ? row.map(unescapeCsvCell) : row);
  return ok({ headers: clean(first), rows: rest.map(clean), delimiter, encoding });
}

function tooLong(limit: number, line: number) {
  return err({ kind: 'cell-too-long' as const, limit, line, message: `A cell in line ${line} is longer than ${limit} characters.` });
}

function limitOf(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`readCsv(): ${name} must be a positive whole number.`);
  return value;
}

function decode(bytes: Uint8Array, wanted: CsvEncoding | undefined): Result<{ text: string; encoding: CsvEncoding }, CsvReadError> {
  // A byte order mark decides; one that contradicts the encoding the app named means the app's guess about the file is wrong.
  let marked: CsvEncoding | undefined;
  let skip = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) [marked, skip] = ['utf-8', 3];
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) [marked, skip] = ['utf-16le', 2];
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) [marked, skip] = ['utf-16be', 2];
  const notText = err({ kind: 'not-text' as const, message: 'The file is not a text file in a known encoding.' });
  if (marked !== undefined && wanted !== undefined && marked !== wanted) return notText;

  let encoding: CsvEncoding | undefined = marked ?? wanted;
  const body = skip > 0 ? bytes.subarray(skip) : bytes;
  const strict = (label: string): string | null => {
    try {
      return new TextDecoder(label, { fatal: true }).decode(body);
    } catch {
      return null;
    }
  };

  let text: string | null;
  if (encoding === undefined) {
    // Without a byte order mark, bytes that are valid UTF-8 are UTF-8; a spreadsheet's legacy export is not.
    text = strict('utf-8');
    encoding = 'utf-8';
    if (text === null) {
      text = new TextDecoder('windows-1252').decode(body);
      encoding = 'windows-1252';
    }
  } else if (encoding === 'windows-1252') text = new TextDecoder('windows-1252').decode(body);
  else text = strict(encoding);

  // A NUL is binary (an image, an archive), and in UTF-16 a stray byte pair decodes to one only by accident.
  if (text === null || text.includes('\0')) return notText;
  return ok({ text, encoding });
}

const CANDIDATES: readonly CsvDelimiter[] = ['\t', ';', ','];
const EARLY_RECORDS = 6;

/** The widths of the first records when `delimiter` separates them, with the parser's quote rule: a quote opens only at the start of a cell. */
function widths(text: string, delimiter: CsvDelimiter): number[] {
  const separator = delimiter.charCodeAt(0);
  const found: number[] = [];
  const length = text.length;
  let i = 0;
  while (i < length && found.length < EARLY_RECORDS) {
    let columns = 0;
    let blank = true;
    for (;;) {
      columns++;
      let empty = true; // the cell's content, as the parser sees it: `""` is empty too
      if (text.charCodeAt(i) === QUOTE) {
        empty = text.charCodeAt(i + 1) === QUOTE && text.charCodeAt(i + 2) !== QUOTE;
        i++;
        for (;;) {
          if (i >= length) return found; // unclosed: the parser will say so
          if (text.charCodeAt(i) === QUOTE) {
            if (text.charCodeAt(i + 1) === QUOTE) i += 2;
            else {
              i++;
              break;
            }
          } else i++;
        }
      }
      const tail = i;
      while (i < length) {
        const code = text.charCodeAt(i);
        if (code === separator || code === LF || code === CR) break;
        i++;
      }
      if (i > tail) empty = false;
      if (!empty) blank = false;
      if (i < length && text.charCodeAt(i) === separator) {
        i++;
        continue;
      }
      break;
    }
    if (i < length) {
      if (text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF) i++;
      i++;
    }
    if (!blank) found.push(columns);
  }
  return found;
}

/**
 * The delimiter with the most separators in the header. When several keep every early row at the header's width, the order tab,
 * `;`, `,` decides.
 */
function detectDelimiter(text: string): CsvDelimiter {
  let best: CsvDelimiter = ',';
  let bestSeparators = 0;
  let bestSteady = false;
  for (const candidate of CANDIDATES) {
    const found = widths(text, candidate);
    const separators = (found[0] ?? 1) - 1;
    const steady = found.every((width) => width === found[0]);
    if (separators > bestSeparators || (separators > 0 && separators === bestSeparators && steady && !bestSteady)) {
      best = candidate;
      bestSeparators = separators;
      bestSteady = steady;
    }
  }
  return best;
}
