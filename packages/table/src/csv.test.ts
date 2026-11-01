import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvCell, csvLine, unescapeCsvCell, writeCsv } from './csv.ts';
import { readCsv } from './csv-read.ts';

describe('CSV cells (RFC 4180 + OWASP "CSV Injection")', () => {
  it.each([
    ['=HYPERLINK("http://evil.example","x")', '"\'=HYPERLINK(""http://evil.example"",""x"")"'],
    ['+1+1', '"\'+1+1"'],
    ['-2+3', '"\'-2+3"'],
    ['@SUM(A1)', '"\'@SUM(A1)"'],
    ['\t=1', '"\'\t=1"'],
    ['\r=1', '"\'\r=1"'],
    ['\n=1', '"\'\n=1"'],
  ])('escapes a text that starts like a formula: %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it.each([
    ' =1+1',
    '  @SUM(A1)',
    ' =1',
    '\u3000=1',
    '\uFEFF=1',
    '\u200B=1',
    '\u200E=1',
    '\u200F+1',
    '\u2060-1+1',
    '\u00AD=1',
    '\v=1',
    '\f=1',
    ' \t=1',
    '\uFF1D1+1',
    '\uFF0B1',
    '\uFF0D1+1',
    '\uFF20SUM(A1)',
    '\uFE661',
    '\uFE621',
    '\uFE631',
    '\uFE6B1',
    '\u207C1',
    '\u208C1',
    '\u207A1',
    '\u208A1',
    '\u22125',
    '\u207B1',
    '\u208B1',
    ' \uFF1D1',
    '\uFEFF \u200B=1',
  ])('escapes a formula behind spaces, invisible characters or in full width: %j', (value) => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  });

  it.each(['a =1', 'x\uFF1D1', ' x', ' ', '\uFEFF', '-5', '-12.50', "\u200B'=1", ''])(
    'leaves a text that is no formula as it is: %j',
    (value) => {
      expect(csvCell(value)).toBe(`"${value}"`);
    },
  );

  it('escapes 100000 spaces in front of a formula without backtracking', () => {
    const value = `${' '.repeat(100_000)}=1`;
    expect(csvCell(value)).toBe(`"'${value}"`);
  }, 1000);

  it('keeps a decimal that arrives as text a number — and still escapes everything that is more than digits', () => {
    expect(csvCell('-12.50')).toBe('"-12.50"');
    expect(csvCell('-5')).toBe('"-5"');
    expect(csvCell('+5')).toBe('"\'+5"');
    for (const text of ['-1+cmd|\'/C calc\'!A0', '-2E3', '-1e5', '-2+3', '-.5', '-5.', '-1.2.3', '--5', '-5 ', '-5\n', '-1,5', '-１', '-1\t']) {
      expect(csvCell(text), text).toBe(`"'${text}"`);
    }
    expect(csvCell(['-12.50'])).toBe('"[""-12.50""]"');
    expect(csvCell(-12.5)).toBe('"-12.5"');
  });

  it('quotes every field and doubles quotes — a separator or a line break inside stays in its cell', () => {
    expect(csvCell('Ada')).toBe('"Ada"');
    expect(csvCell('Ada "the first" Lovelace')).toBe('"Ada ""the first"" Lovelace"');
    expect(csvCell('a,b\r\nc')).toBe('"a,b\r\nc"');
    expect(csvCell('mid=dle')).toBe('"mid=dle"');
  });

  it('writes numbers, booleans, dates and empties as values — a negative number is no formula', () => {
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell(12.5)).toBe('"12.5"');
    expect(csvCell(Number.NaN)).toBe('""');
    expect(csvCell(true)).toBe('"true"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(new Date('2026-10-06T12:00:00Z'))).toBe('"2026-10-06T12:00:00.000Z"');
  });

  it('escapes JSON values too (a JSON column that is a string starting with =)', () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(['=1'])).toBe('"[""=1""]"');
  });

  describe('undoing the escape', () => {
    const starts = ['=', '+', '-', '@', '\t', '\r', '\n', '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20', '\uFE66', '\u2212'];
    const spaces = ['', ' ', '\u3000', '\uFEFF', '\u200B', '\u200E', ' \u200B', '\v'];
    const unquote = (cell: string): string => cell.slice(1, -1).replaceAll('""', '"');

    it('escapes a leading quote before a formula character once more, so no two texts give the same cell', () => {
      expect(csvCell("'=x")).toBe(`"''=x"`);
      expect(csvCell("''=x")).toBe(`"'''=x"`);
      expect(csvCell("'-5")).toBe(`"''-5"`);
      expect(csvCell('=x')).not.toBe(csvCell("'=x"));
      expect(csvCell("'x")).toBe(`"'x"`);
      expect(csvCell("'")).toBe(`"'"`);
      expect(csvCell('')).toBe('""');
    });

    it.each([
      ['=x', "'=x"],
      ["'=x", "''=x"],
      ["''=x", "'''=x"],
      ['-5', '-5'],
      ["'-5", "''-5"],
      ['-2+3', "'-2+3"],
      ["'", "'"],
      ['', ''],
      ["'x", "'x"],
      ['a=b', 'a=b'],
    ])('writes %j as %j and reads it back', (value, written) => {
      expect(unquote(csvCell(value))).toBe(written);
      expect(unescapeCsvCell(written)).toBe(value);
    });

    it('gives back every text with or without leading quotes before any formula character', () => {
      for (const start of starts) {
        for (const quotes of ['', "'", "''", "'''"]) {
          for (const space of spaces) {
            for (const rest of ['', 'x', '1', '5.5', "'=", '"q"']) {
              const value = `${quotes}${space}${start}${rest}`;
              expect(unescapeCsvCell(unquote(csvCell(value))), JSON.stringify(value)).toBe(value);
            }
          }
        }
      }
    });

    it('never leaves an exported cell that starts like a formula, so undoing is the only way to one', () => {
      for (const start of starts) {
        for (const quotes of ['', "'", "''"]) {
          for (const space of spaces) {
            const written = unquote(csvCell(`${quotes}${space}${start}1+1`));
            expect(written.startsWith("'"), JSON.stringify(written)).toBe(true);
          }
        }
      }
    });

    it('gives back a formula behind spaces or invisible characters, with or without a quote in front', () => {
      for (const value of [' =1', "' =1", '\uFEFF=1', '\uFF1D1', "'\uFF1D1"]) {
        expect(unescapeCsvCell(unquote(csvCell(value))), value).toBe(value);
      }
    });

    it('does not turn a text that was no formula into one', () => {
      for (const value of ["'x", "''", "'1", "a'=", "x'=1", '\u200B\'=1', "'a =1"]) {
        expect(unescapeCsvCell(value), value).toBe(value);
        expect(unescapeCsvCell(unquote(csvCell(value))), value).toBe(value);
      }
    });
  });

  it('ends a line with CRLF', () => {
    expect(csvLine(['a', 1, null])).toBe('"a","1",""\r\n');
  });
});

describe('writeCsv()', () => {
  const CELLS = ['=x', '+x', '-x', '@x', '\tx', '\rx', '\nx', '  =x', '\u200B=x', '\uFF1Dx', '\u2212x', "'=x", "'  =x", '-12.50', '-2E3', 'plain', 'say "hi"', 'a,b;c'];

  it('puts the byte order mark first and ends every line with CRLF, every cell quoted', () => {
    expect(writeCsv([['name', 'n'], ['Ada', 1]])).toBe(`${CSV_BOM}"name","n"\r\n"Ada","1"\r\n`);
    expect(writeCsv([['a']], { bom: false })).toBe('"a"\r\n');
    expect(writeCsv([])).toBe(CSV_BOM);
  });

  it('takes any iterable of rows', () => {
    expect(writeCsv(new Set([['a'], ['b']]), { bom: false })).toBe('"a"\r\n"b"\r\n');
  });

  it('escapes every cell that starts like a formula and leaves a plain decimal alone', () => {
    const written = writeCsv([CELLS], { bom: false });
    expect(written).toBe(`${CELLS.map(csvCell).join(',')}\r\n`);
    for (const formula of ['=x', '+x', '-x', '@x', '\tx', '\rx', '\nx', '  =x', '\u200B=x', '\uFF1Dx', '\u2212x', "'=x", "'  =x", '-2E3']) {
      expect(written, JSON.stringify(formula)).toContain(`"'${formula}"`);
    }
    expect(written).toContain('"-12.50"');
    expect(written).not.toContain('"\'-12.50"');
  });

  it('is read back cell for cell with readCsv({ unescape: true }), whatever the delimiter', () => {
    for (const delimiter of [',', ';', '\t'] as const) {
      const file = writeCsv([CELLS.map((_, index) => `h${index}`), CELLS], { delimiter });
      const read = readCsv(Buffer.from(file), { unescape: true, delimiter });
      expect(read.ok && read.value.rows, JSON.stringify(delimiter)).toEqual([CELLS]);
    }
  });

  it('writes what the reader refuses: a cell over maxCellLength and a NUL are no round trip', () => {
    const long = readCsv(Buffer.from(writeCsv([['a'], ['x'.repeat(10_001)]])));
    expect(!long.ok && long.error.kind).toBe('cell-too-long');
    const nul = readCsv(Buffer.from(writeCsv([['a'], ['x\0y']])));
    expect(!nul.ok && nul.error.kind).toBe('not-text');
  });

  it('separates by the delimiter and refuses any other', () => {
    expect(writeCsv([['a', 'b']], { delimiter: ';', bom: false })).toBe('"a";"b"\r\n');
    expect(writeCsv([['a', 'b']], { delimiter: '\t', bom: false })).toBe('"a"\t"b"\r\n');
    for (const delimiter of ['|', '"', '=', '', ';;']) expect(() => writeCsv([['a']], { delimiter: delimiter as never })).toThrow(TypeError);
  });
});
