import { describe, expect, it } from 'vitest';
import { contentDisposition } from './index.ts';

describe('contentDisposition()', () => {
  it('names a download in an ASCII form and a UTF-8 form, and lets no character leave the parameter', () => {
    expect(contentDisposition('attachment', 'report.csv')).toBe(`attachment; filename="report.csv"; filename*=UTF-8''report.csv`);
    const value = contentDisposition('inline', 'a"b\r\nX-Evil: 1/ü.csv');
    expect(value).not.toMatch(/[\r\n]/);
    expect(/filename="([^"]*)"/.exec(value)![1]).toBe('a_b__X-Evil: 1__.csv');
  });

  it('does not throw on a lone surrogate', () => {
    expect(contentDisposition('attachment', 'a\uD800.csv')).toContain("filename*=UTF-8''a%EF%BF%BD.csv");
  });
});
