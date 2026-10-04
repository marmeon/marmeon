import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.ts';
import type { DocNode } from './types.ts';

const pageOf = (file: string) => (file === 'README.md' ? '/' : /^packages\/(\w+)\/README\.md$/.exec(file) ? `/packages/${/^packages\/(\w+)\//.exec(file)![1]}` : undefined);
const render = (source: string, file = 'packages/http/README.md') => renderMarkdown(source, { file, pageOf, highlight: (code) => `<pre>${code}</pre>` });

/** The tree as markup — what React renders from it. */
function html(nodes: readonly DocNode[]): string {
  return nodes
    .map((node) => {
      if (typeof node === 'string') return node.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if ('html' in node) return node.html;
      const attributes = Object.entries(node.a ?? {}).map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${value}"`)).join('');
      return `<${node.t}${attributes}>${html(node.c ?? [])}</${node.t}>`;
    })
    .join('');
}

describe('README markdown', () => {
  it('shows raw HTML as text — a <script> in a README never becomes markup', () => {
    const { body } = render('# T\n\n<script>alert(1)</script>\n\nText <img src=x onerror=alert(1)> and <b>bold</b>.\n\n[x](javascript:alert(1))');
    const markup = html(body);
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toMatch(/<script|<img|<b>|href="javascript/);
  });

  it('gives headings GitHub’s anchors — duplicates numbered — and builds the table of contents from H2 and H3', () => {
    const { title, toc, anchors } = render(
      '# @bespokecore/x\n\n## Diagnostics: `@bespokecore/core/diagnostics` (E118)\n\n### The pages: `/_bespoke/devtools`\n\n## Auth & Mail\n\n#### Deep\n\n## Auth & Mail',
    );
    expect(title).toBe('@bespokecore/x');
    expect(toc).toEqual([
      { depth: 2, text: 'Diagnostics: @bespokecore/core/diagnostics (E118)', id: 'diagnostics-bespokecorecorediagnostics-e118' },
      { depth: 3, text: 'The pages: /_bespoke/devtools', id: 'the-pages-_bespokedevtools' },
      { depth: 2, text: 'Auth & Mail', id: 'auth--mail' },
      { depth: 2, text: 'Auth & Mail', id: 'auth--mail-1' },
    ]);
    expect(anchors).toContain('deep');
  });

  it('turns links to READMEs into page links, keeps anchors into the page itself, and shows links to source files as code text', () => {
    const markup = html(
      render(
        '# H\n\nSee [the router](../router/README.md#middleware), [the start](../../README.md), [here](#features), ' +
          '[this page](./README.md#the-protocol), [the kernel](src/kernel.ts), [Kysely](https://kysely.dev).',
      ).body,
    );
    expect(markup).toContain('<a href="/packages/router#middleware" data-internal>the router</a>');
    expect(markup).toContain('<a href="/" data-internal>the start</a>');
    expect(markup).toContain('<a href="#features">here</a>');
    expect(markup).toContain('<a href="#the-protocol">this page</a>');
    expect(markup).toContain('<span class="file">the kernel</span>');
    expect(markup).toContain('<a href="https://kysely.dev" rel="noopener">Kysely</a>');
  });

  it('renders GitHub alerts as callouts, tables with their alignment, code blocks through the highlighter', () => {
    const markup = html(render('# H\n\n> [!WARNING]\n> Careful.\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```').body);
    expect(markup).toContain('<aside class="callout warning" role="note"><p class="callout-title">Warning</p><p>Careful.</p></aside>');
    expect(markup).toContain('<th class="left">a</th><th class="right">b</th>');
    expect(markup).toContain('<pre>const x = 1;\n</pre>');
  });

  it('splits the page into sections for the search: heading, anchor and text (code included)', () => {
    const { sections } = render('# @bespokecore/x\n\nIntro.\n\n## Locks\n\nUse `onOneServer()`.\n\n```ts\ns.command(x).onOneServer();\n```');
    expect(sections).toEqual([
      { heading: '@bespokecore/x', anchor: '', depth: 1, text: 'Intro.' },
      { heading: 'Locks', anchor: 'locks', depth: 2, text: 'Use onOneServer(). s.command(x).onOneServer();' },
    ]);
  });
});
