import { beforeAll, describe, expect, it } from 'vitest';
import { createCodeHighlighter, type CodeHighlighter } from './highlight.ts';

describe('highlight', () => {
  let highlighter: CodeHighlighter;
  beforeAll(async () => {
    highlighter = await createCodeHighlighter();
  });

  it('gives every role of a ts snippet its class and leaves no inline style', () => {
    const html = highlighter.highlight("export class A extends HttpContext { run() { return 'x'; } } // note", 'ts');
    expect(html).toContain('<span class="tk">export</span>');
    expect(html).toContain('<span class="ty"> HttpContext</span>');
    expect(html).toContain('<span class="tf"> run</span>');
    expect(html).toMatch(/<span class="ts">\s*'x'<\/span>/);
    expect(html).toContain('<span class="tc"> // note</span>');
    expect(html).not.toContain('style=');
    expect(highlighter.unknownColours()).toEqual([]);
  });

  it('marks the block with its language and falls back to plain text for an unknown one', () => {
    expect(highlighter.highlight('pnpm add x', 'sh')).toContain('data-lang="sh"');
    const unknown = highlighter.highlight('some <b>text</b>', 'cobol');
    expect(unknown).toContain('data-lang="text"');
    expect(unknown).not.toContain('class="t');
    expect(unknown).not.toContain('style=');
  });

  it('escapes markup in the code', () => {
    const html = highlighter.highlight('<script>alert(1)</script>', 'html');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#x3C;');
  });
});
