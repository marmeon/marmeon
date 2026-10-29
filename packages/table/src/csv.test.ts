import { describe, expect, it } from 'vitest';
import { csvCell, csvLine, unescapeCsvCell } from './csv.ts';

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
    const starts = ['=', '+', '-', '@', '\t', '\r', '\n'];
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
          for (const rest of ['', 'x', '1', '5.5', "'=", '"q"']) {
            const value = `${quotes}${start}${rest}`;
            expect(unescapeCsvCell(unquote(csvCell(value))), JSON.stringify(value)).toBe(value);
          }
        }
      }
    });

    it('never leaves an exported cell that starts like a formula, so undoing is the only way to one', () => {
      for (const start of starts) {
        for (const quotes of ['', "'", "''"]) {
          const written = unquote(csvCell(`${quotes}${start}1+1`));
          expect(written.startsWith("'"), JSON.stringify(written)).toBe(true);
        }
      }
    });

    it('does not turn a text that was no formula into one', () => {
      for (const value of ["'x", "''", "'1", "a'=", ' =1', "x'=1"]) {
        expect(unescapeCsvCell(value), value).toBe(value);
        expect(unescapeCsvCell(unquote(csvCell(value))), value).toBe(value);
      }
    });
  });

  it('ends a line with CRLF', () => {
    expect(csvLine(['a', 1, null])).toBe('"a","1",""\r\n');
  });
});
