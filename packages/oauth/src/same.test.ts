import { describe, expect, it } from 'vitest';
import { same } from './same.ts';

describe('same()', () => {
  it('compares texts exactly', () => {
    expect(same('abc', 'abc')).toBe(true);
    expect(same('abc', 'abd')).toBe(false);
    expect(same('abc', 'ab')).toBe(false);
  });

  it('is false when a text is not well formed, as a lone surrogate would equal U+FFFD once encoded', () => {
    expect(same('a\uD800', 'a�')).toBe(false);
    expect(same('a�', 'a\uD800')).toBe(false);
    expect(same('a\uD800', 'a\uD800')).toBe(false);
  });
});
