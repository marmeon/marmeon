import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodeBlock } from './CodeBlock.tsx';
import { Terminal } from './Terminal.tsx';

const html = '<pre class="code" tabindex="0" data-lang="ts"><span class="tk">const</span> x = 1;\n</pre>';

describe('the copy button is progressive enhancement', () => {
  it('Terminal renders the prompt apart from the text, and no button or live region on the server', () => {
    const markup = renderToString(createElement(Terminal, { commands: ['pnpm i', 'pnpm dev'] }));
    expect(markup).toContain('<span class="prompt" aria-hidden="true">$ </span>');
    expect(markup).toContain('TERMINAL');
    expect(markup).not.toContain('copy-button');
    expect(markup).not.toContain('aria-live');
  });

  it('CodeBlock with a caption is a figure.code with a figcaption around a div.code-block', () => {
    const markup = renderToString(createElement(CodeBlock, { html, caption: 'x.ts' }));
    expect(markup).toMatch(/^<figure class="code"><figcaption><span class="code-caption">x\.ts<\/span><\/figcaption><div class="code-block"><div class="code-source">/);
    expect(markup).toContain(html);
    expect(markup).not.toContain('copy-button');
    expect(markup).not.toContain('aria-live');
  });

  it('CodeBlock without a caption is a bare div.code-block', () => {
    const markup = renderToString(createElement(CodeBlock, { html }));
    expect(markup).toMatch(/^<div class="code-block"><div class="code-source">/);
    expect(markup).not.toContain('<figure');
    expect(markup).not.toContain('copy-button');
  });
});
