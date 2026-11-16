import { describe, expect, it } from 'vitest';
import { roman } from './roman.ts';

describe('roman', () => {
  it('writes the number of a section in Roman numerals', () => {
    expect([1, 4, 9, 11, 14, 40, 90, 400, 900, 1994, 3999].map(roman)).toEqual(['I', 'IV', 'IX', 'XI', 'XIV', 'XL', 'XC', 'CD', 'CM', 'MCMXCIV', 'MMMCMXCIX']);
  });

  it('writes nothing for zero', () => {
    expect(roman(0)).toBe('');
  });
});
