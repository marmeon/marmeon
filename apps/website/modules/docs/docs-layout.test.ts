import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SSR_TEST_TIMEOUT } from './test-timeouts.ts';

describe('the layout of a docs page (server-rendered)', () => {
  it('opens the current section only, marks the current page and a draft, names the neighbours’ sections, and searches without JavaScript', async () => {
    const ssr = await createTestApp(application, { ssr: true });
    const response = await ssr.get('/docs/routing', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
    // React separates adjacent text nodes with comments.
    const body = response.body.replace(/<!-- -->/g, '');
    const section = (title: string) => new RegExp(`<details class="nav-section"( open="")?><summary>${title}<`);
    expect(section('The Basics').exec(body)?.[1]).toBe(' open=""');
    expect(section('Frontend').exec(body)?.[1]).toBeUndefined();
    expect(body).toContain('aria-current="page"');
    expect(body).toMatch(/<a [^>]*aria-current="page"[^>]*>Routing</);
    expect(body).toContain('Previous · Architecture Concepts');
    expect(body).toContain('<span class="pager-title">Context</span>');
    expect(body).toContain('Next · The Basics');
    // Both triggers are links: the layer with JavaScript, the search page without.
    for (const name of ['docs-search-box', 'docs-search-link']) {
      expect(body, name).toMatch(new RegExp(`<a [^>]*href="/docs/search"[^>]*class="${name}"[^>]*aria-keyshortcuts="/"|<a [^>]*class="${name}"[^>]*href="/docs/search"[^>]*aria-keyshortcuts="/"`));
    }
    expect(body.match(/<a [^>]*data-search-trigger/g)).toHaveLength(2);
    expect(body.slice(body.indexOf('class="docs-top"'), body.indexOf('</header>'))).not.toContain('<input');
    expect(body).not.toMatch(/<form [^>]*action="\/docs\/search"/);
    expect(body).not.toContain('style=');
    expect(body).toContain('<details class="toc-mobile">');
    expect(body).toContain('<details class="docs-menu">');
  }, SSR_TEST_TIMEOUT);

  it('renders the start page and the search without the section navigation — the search also without the top field', async () => {
    const ssr = await createTestApp(application, { ssr: true });
    for (const path of ['/docs', '/docs/search?q=routing']) {
      const { body } = await ssr.get(path, { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
      expect(body, path).not.toContain('class="sidebar"');
      expect(body, path).not.toContain('class="docs-menu"');
      expect(body, path).toContain('class="docs-top"');
      if (path.startsWith('/docs/search')) expect(body, path).not.toContain('data-search-trigger');
    }
  }, SSR_TEST_TIMEOUT);
});
