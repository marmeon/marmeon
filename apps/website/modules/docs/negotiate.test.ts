import { describe, expect, it } from 'vitest';
import { prefersMarkdown } from './negotiate.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';

const asks = (accept?: string, extra: Record<string, string> = {}) => prefersMarkdown(new Request('http://localhost/docs', { headers: { ...(accept === undefined ? {} : { accept }), ...extra } }));

describe('prefersMarkdown', () => {
  it.each([
    ['Chrome', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'],
    ['Firefox and Safari', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
    ['any type', '*/*'],
    ['any text', 'text/*'],
    ['Markdown behind a heavier wildcard', 'text/markdown;q=0.5, */*;q=0.8'],
    ['Markdown behind HTML', 'text/markdown;q=0.5, text/html'],
    ['Markdown refused', 'text/markdown;q=0'],
    ['a weight that is no number', 'text/markdown;q=abc'],
    ['a weight above 1', 'text/markdown;q=2'],
    ['a negative weight', 'text/markdown;q=-1'],
    ['only separators', ',,;;'],
    ['HTML only', 'text/html'],
  ])('is false for %s', (_name, accept) => {
    expect(asks(accept)).toBe(false);
  });

  it('is false without an Accept header', () => {
    expect(asks()).toBe(false);
  });

  it.each([
    ['text/markdown'],
    ['TEXT/Markdown; charset=utf-8'],
    ['text/markdown, text/html;q=0.9'],
    ['text/markdown, text/html'],
    ['text/html, text/markdown'],
    ['text/markdown;q=0.5, text/html;q=0.5'],
    ['text/markdown, */*;q=0.8'],
    ['text/markdown;q=0.9, text/*;q=0.8'],
    ['text/markdown;q=0.001'],
  ])('is true for %s', (accept) => {
    expect(asks(accept)).toBe(true);
  });

  it('is false for a Visit, a partial reload or a layer, whatever it accepts', () => {
    expect(asks('text/markdown', { [PAGE_HEADER]: PROTOCOL_VERSION })).toBe(false);
  });

  it('counts the first 64 ranges only', () => {
    expect(asks(`${'a/b,'.repeat(10_000)}text/markdown`)).toBe(false);
    expect(asks(`${'a/b,'.repeat(63)}text/markdown`)).toBe(true);
  });
});
