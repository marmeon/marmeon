import { describe, expect, it } from 'vitest';
import { csvCell, csvLine } from './csv.ts';

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

  it('ends a line with CRLF', () => {
    expect(csvLine(['a', 1, null])).toBe('"a","1",""\r\n');
  });
});
