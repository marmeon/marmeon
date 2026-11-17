import { createTestApp, startSsrServer, type SsrServer } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import docsConfig from '../../docs.config.ts';
import { roman } from './roman.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

describe('the layout of a docs page (server-rendered)', () => {
  it('opens the current section only, marks the current page and a draft, names the neighbours’ sections, and searches without JavaScript', async () => {
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
    const response = await ssr.get('/docs/routing', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
    // React separates adjacent text nodes with comments.
    const body = response.body.replace(/<!-- -->/g, '');
    const section = (title: string, numeral: string) => new RegExp(`<details class="nav-section"( open="")?><summary><span class="nav-number" aria-hidden="true">${numeral}</span>${title}<`);
    expect(section('The Basics', 'V').exec(body)?.[1]).toBe(' open=""');
    expect(section('Frontend', 'VI').exec(body)?.[1]).toBeUndefined();
    // Every section's numeral is its place in docs.config.ts.
    docsConfig.sections.forEach((group, index) => expect(body, group.title).toMatch(section(group.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), roman(index + 1))));
    expect(body).toContain('aria-current="page"');
    expect(body).toMatch(/<a [^>]*aria-current="page"[^>]*>Routing</);
    expect(body).toContain('Previous · Architecture Concepts');
    expect(body).toContain('<span class="pager-title">Context</span>');
    expect(body).toContain('Next · The Basics');
    // Both triggers are links: the layer with JavaScript, the search page without.
    for (const name of ['docs-search-box', 'docs-search-link']) {
      expect(body, name).toMatch(new RegExp(`<a [^>]*href="/docs/search"[^>]*class="${name}"[^>]*aria-keyshortcuts="Control\\+K Meta\\+K"|<a [^>]*class="${name}"[^>]*href="/docs/search"[^>]*aria-keyshortcuts="Control\\+K Meta\\+K"`));
    }
    expect(body.match(/<a [^>]*data-search-trigger/g)).toHaveLength(2);
    const top = body.slice(body.indexOf('class="docs-top stage"'), body.indexOf('</header>'));
    expect(top).not.toContain('<input');
    // The shortcut hint renders only once hydrated: the server's top bar names no key.
    expect(top).not.toContain('<kbd');
    expect(body).not.toMatch(/<form [^>]*action="\/docs\/search"/);
    expect(body).not.toContain('style=');
    expect(body).toContain('<details class="toc-mobile">');
    expect(body).toContain('<details class="docs-menu">');
  });

  it('names the page above its heading: a breadcrumb ending in the current page, the section as a numeral, and the package it documents as a chip', async () => {
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
    const response = await ssr.get('/docs/routing', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
    const body = response.body.replace(/<!-- -->/g, '');
    expect(body).toMatch(/<nav aria-label="Breadcrumb"><ol><li><a [^>]*href="\/docs"[^>]*>Docs<\/a><\/li><li>The Basics<\/li><li [^>]*aria-current="page"[^>]*>Routing<\/li><\/ol><\/nav>/);
    expect(body).toContain('<p class="doc-eyebrow">V · The Basics</p>');
    expect(body).toMatch(/<ul class="doc-packages" aria-label="Packages"><li>@marmeon\/router<\/li><\/ul>/);
    // The newest page tells an agent how to read it; the copy button needs JavaScript, so the server renders none.
    expect(body).toContain('<code>docs_read { &quot;page&quot;: &quot;routing&quot; }</code>');
    expect(body).toContain('the docs_read tool of marmeon mcp');
    expect(body).not.toContain('Copy page');
    expect(body).toContain('View as Markdown');
  });

  it('shows no package chip on a page that documents none', async () => {
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
    const { body } = await ssr.get('/docs/context', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
    expect(body).not.toContain('doc-packages');
  });

  it('renders the start page and the search without the section navigation — the search also without the top field', async () => {
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
    for (const path of ['/docs', '/docs/search?q=routing']) {
      const { body } = await ssr.get(path, { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
      expect(body, path).not.toContain('class="sidebar"');
      expect(body, path).not.toContain('class="docs-menu"');
      expect(body, path).toContain('class="docs-top stage"');
      if (path.startsWith('/docs/search')) expect(body, path).not.toContain('data-search-trigger');
    }
  });
});
