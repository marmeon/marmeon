import { describe, expect, it } from 'vitest';
import { escapeSlackText } from '../escape.ts';
import { fitEscaped, largest, plain } from './fit.ts';

describe('fitEscaped', () => {
  it('returns the escaped text whole when it fits exactly', () => {
    expect(fitEscaped('a&b', escapeSlackText, 7)).toBe('a&amp;b');
    expect(fitEscaped('a&b', escapeSlackText, 6)).toBe('a…');
  });

  it('cuts the source after a space without leaving the space before the ellipsis', () => {
    expect(fitEscaped('ab cd', plain, 4)).toBe('ab…');
  });

  it('never cuts inside an escape or a surrogate pair', () => {
    expect(fitEscaped('&&&&', escapeSlackText, 10)).toBe('&amp;…');
    expect(fitEscaped('\u{1F600}\u{1F600}', plain, 2)).toBe('…');
    expect(fitEscaped('\u{1F600}\u{1F600}', plain, 3)).toBe('\u{1F600}…');
  });

  it('gives an empty text for a limit below 1 and the ellipsis alone for 1', () => {
    expect(fitEscaped('abc', plain, 0)).toBe('');
    expect(fitEscaped('abc', plain, 1)).toBe('…');
  });
});

describe('largest', () => {
  it('finds the last count that fits, and nothing when not even the lowest does', () => {
    expect(largest(2, 100, (count) => count <= 37)).toBe(37);
    expect(largest(2, 100, (count) => count <= 1)).toBeUndefined();
    expect(largest(5, 5, () => true)).toBe(5);
  });
});
