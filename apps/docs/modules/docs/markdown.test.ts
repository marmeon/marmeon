import { describe, expect, it } from 'vitest';
import { PENDING_MARKER, renderMarkdown } from './markdown.ts';
import type { DocNode } from './types.ts';

/** As the repository maps them: `docs/<slug>.md` is a page — a README is none. */
const pageOf = (file: string) => {
  const doc = /^docs\/([a-z-]+)\.md$/.exec(file)?.[1];
  return doc ? `/docs/${doc}` : undefined;
};
const render = (source: string, file = 'docs/routing.md') => renderMarkdown(source, { file, pageOf, highlight: (code) => `<pre>${code}</pre>` });

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

describe('the markdown of a page', () => {
  it('shows raw HTML as text — a <script> in a page never becomes markup', () => {
    const { body } = render('# T\n\n<script>alert(1)</script>\n\nText <img src=x onerror=alert(1)> and <b>bold</b>.\n\n[x](javascript:alert(1))');
    const markup = html(body);
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toMatch(/<script|<img|<b>|href="javascript/);
  });

  it('gives headings GitHub’s anchors — duplicates numbered — and builds the table of contents from H2 and H3', () => {
    const { title, toc, anchors } = render(
      '# @marmeon/x\n\n## Diagnostics: `@marmeon/core/diagnostics` (E118)\n\n### The pages: `/_marmeon/devtools`\n\n## Auth & Mail\n\n#### Deep\n\n## Auth & Mail',
    );
    expect(title).toBe('@marmeon/x');
    expect(toc).toEqual([
      { depth: 2, text: 'Diagnostics: @marmeon/core/diagnostics (E118)', id: 'diagnostics-marmeoncorediagnostics-e118' },
      { depth: 3, text: 'The pages: /_marmeon/devtools', id: 'the-pages-_marmeondevtools' },
      { depth: 2, text: 'Auth & Mail', id: 'auth--mail' },
      { depth: 2, text: 'Auth & Mail', id: 'auth--mail-1' },
    ]);
    expect(anchors).toContain('deep');
  });

  it('turns links to docs pages into page links, keeps anchors into the page itself, and shows links to source files as code text', () => {
    const markup = html(
      render(
        '# H\n\nSee [middleware](middleware.md#groups), [forms](../docs/forms.md#validation), [here](#features), ' +
          '[this page](./routing.md#the-protocol), [the kernel](../packages/server/src/kernel.ts), [Kysely](https://kysely.dev).',
      ).body,
    );
    expect(markup).toContain('<a href="/docs/middleware#groups" data-internal>middleware</a>');
    expect(markup).toContain('<a href="/docs/forms#validation" data-internal>forms</a>');
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

  it('splits the page into sections for the search: heading, anchor, its prose and its code blocks apart', () => {
    const { sections } = render('# @marmeon/x\n\nIntro.\n\n## Locks\n\nUse `onOneServer()`.\n\n```ts\ns.command(x).onOneServer();\n```');
    expect(sections).toEqual([
      { heading: '@marmeon/x', anchor: '', depth: 1, text: 'Intro.', code: '' },
      { heading: 'Locks', anchor: 'locks', depth: 2, text: 'Use onOneServer().', code: 's.command(x).onOneServer();' },
    ]);
  });

  it('keeps a link to the root README code text — it is no page (a page link to /README.md would be a broken link)', () => {
    const fromDocs = render('# H\n\nSee [the README](../README.md#versions-and-deprecations).');
    expect(html(fromDocs.body)).toContain('<span class="file">the README</span>');
    expect(fromDocs.fileLinks).toEqual(['README.md']);
    const fromPolicy = render('# H\n\n[Back](README.md)', 'UPGRADING.md');
    expect(html(fromPolicy.body)).toContain('<span class="file">Back</span>');
    expect(fromPolicy.fileLinks).toEqual(['README.md']);
  });

  it('keeps a link to a package README a page link, which no page answers — the link check reports it, code text would hide it', () => {
    const { body, fileLinks } = render('# H\n\nSee [the router](../packages/router/README.md#middleware) and [http](../packages/http/README.md).');
    expect(html(body)).toContain('<a href="/packages/router/README.md#middleware" data-internal>the router</a>');
    expect(html(body)).toContain('<a href="/packages/http/README.md" data-internal>http</a>');
    expect(fileLinks).toEqual([]);
  });

  it('puts the file name of a code block with title="…" above it — a figure with its caption', () => {
    const { body, sections } = render('# H\n\n```ts title="a/b.ts"\nconst x = 1;\n```');
    expect(html(body)).toBe('<figure class="code"><figcaption>a/b.ts</figcaption><pre>const x = 1;\n</pre></figure>');
    expect(body).toEqual([{ t: 'figure', a: { class: 'code' }, c: [{ t: 'figcaption', c: ['a/b.ts'] }, { html: '<pre>const x = 1;\n</pre>' }] }]);
    expect(sections[0]).toMatchObject({ text: '', code: 'const x = 1;' });
  });

  it('highlights a titled block in its language (the first word) and leaves a block without title as it was', () => {
    const languages: string[] = [];
    const highlight = (code: string, lang: string) => (languages.push(lang), `<pre>${code}</pre>`);
    const titled = renderMarkdown('```tsx title="views/Show.tsx"\nx\n```', { file: 'docs/x.md', pageOf, highlight });
    const plain = renderMarkdown('```tsx\nx\n```\n\n```\ny\n```', { file: 'docs/x.md', pageOf, highlight });
    expect(languages).toEqual(['tsx', 'tsx', '']);
    expect(titled.body).toEqual([{ t: 'figure', a: { class: 'code' }, c: [{ t: 'figcaption', c: ['views/Show.tsx'] }, { html: '<pre>x\n</pre>' }] }]);
    expect(plain.body).toEqual([{ html: '<pre>x\n</pre>' }, { html: '<pre>y\n</pre>' }]);
  });

  it('shows a title with quotes or HTML as text — escaped, never markup', () => {
    const markup = html(render(`# H\n\n\`\`\`ts title='say "hi" <img src=x onerror=alert(1)>'\nx\n\`\`\``).body);
    expect(markup).toContain('<figcaption>say "hi" &lt;img src=x onerror=alert(1)&gt;</figcaption>');
    expect(markup).not.toContain('<img');
  });

  it('marks a page with the pending marker and renders no marker text', () => {
    const placeholder = render(`# Routing\n${PENDING_MARKER}\n\n> [!NOTE]\n> This page is being written.\n`, 'docs/routing.md');
    expect(PENDING_MARKER).toBe('<!-- docs:pending -->');
    expect(placeholder.pending).toBe(true);
    expect(placeholder.title).toBe('Routing');
    expect(html(placeholder.body)).toBe('<aside class="callout note" role="note"><p class="callout-title">Note</p><p>This page is being written.</p></aside>');
    expect(JSON.stringify(placeholder)).not.toContain('docs:pending');
    const finished = render('# Routing\n\nText.\n', 'docs/routing.md');
    expect(finished.pending).toBe(false);
    // In a code block the marker is an example, not a mark.
    const shown = render(`# Writing\n\n\`\`\`md\n${PENDING_MARKER}\n\`\`\`\n`, 'CONTRIBUTING.md');
    expect(shown.pending).toBe(false);
    expect(JSON.stringify(shown.body)).toContain('docs:pending');
  });
});
