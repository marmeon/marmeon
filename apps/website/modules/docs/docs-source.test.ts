import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import application from '../../bootstrap/app.ts';
import docsConfig from '../../docs.config.ts';
import { expectOriginFromAppUrl } from '../site/origin.test-support.ts';
import { DocsError, DocsRepository } from './DocsRepository.ts';
import { markdownParser } from './markdown.ts';
import { SSR_TEST_TIMEOUT } from './test-timeouts.ts';

const repo = resolve(import.meta.dirname, '../../../..');
const ENTRIES = docsConfig.sections.flatMap((section) => section.pages);
let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application);
});

describe('/docs/<slug>.md', () => {
  it('serves docs/routing.md byte for byte, as Markdown, cacheable, with the HTML page as canonical', async () => {
    const response = await app.get('/docs/routing.md').assertOk();
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.body).toBe(readFileSync(join(repo, 'docs/routing.md'), 'utf8'));
    expect(response.headers.get('link')).toBe('<http://localhost/docs/routing>; rel="canonical"');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const etag = response.headers.get('etag')!;
    expect(etag).toMatch(/^"[\w-]{27}"$/);
    expect((await app.get('/docs/routing.md', { headers: { 'if-none-match': etag } })).status).toBe(304);
  });

  it('rewrites a link to a root file to its page, and a link to a file without one to GitHub', async () => {
    const upgrading = (await app.get('/docs/upgrading.md').assertOk()).body;
    expect(upgrading).toContain('](releases.md#what-a-version-promises)');
    expect(upgrading).not.toContain('](docs/');
    expect((await app.get('/docs/contributing.md').assertOk()).body).toContain('](https://github.com/marmeon/marmeon/blob/main/README.md#principles)');
    const withSecurity = ENTRIES.find((entry) => !entry.file && readFileSync(join(repo, `docs/${entry.slug}.md`), 'utf8').includes('](../SECURITY.md'))!;
    const body = (await app.get(`/docs/${withSecurity.slug}.md`).assertOk()).body;
    expect(body).not.toContain('](../SECURITY.md');
    expect(body).toContain('](security-policy.md');
  });

  it('leads every link of every page to a served page and an anchor on it', async () => {
    const docs = app.make(DocsRepository);
    const broken: string[] = [];
    for (const entry of ENTRIES) {
      const body = (await app.get(`/docs/${entry.slug}.md`).assertOk()).body;
      const base = new URL(`http://localhost/docs/${entry.slug}.md`);
      for (const token of markdownParser.parse(body, {}).flatMap((block) => block.children ?? [])) {
        if (token.type !== 'link_open') continue;
        const href = String(token.attrGet('href'));
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        const url = new URL(href, base);
        const slug = /^\/docs\/([a-z0-9-]+)\.md$/.exec(url.pathname)?.[1];
        const page = slug ? docs.doc(slug) : undefined;
        if (!page) broken.push(`${entry.slug}: ${href} — no such page`);
        else if (url.hash && !page.anchors.includes(decodeURIComponent(url.hash.slice(1)))) broken.push(`${entry.slug}: ${href} — no such anchor`);
      }
    }
    expect(broken, broken.join('\n')).toEqual([]);
  }, 60_000);

  it('is named by every HTML page of the docs', async () => {
    const ssr = await createTestApp(application, { ssr: true });
    const html = (await ssr.get('/docs/routing', { headers: { accept: 'text/html' } }).assertOk()).body;
    const tag = /<link\b[^>]*rel="alternate"[^>]*>/.exec(html)?.[0];
    expect(tag).toContain('type="text/markdown"');
    expect(tag).toContain('href="/docs/routing.md"');
    await ssr.get('/docs/search', { headers: { accept: 'text/html' } }).assertOk();
  }, SSR_TEST_TIMEOUT);

  it('rewrites a link in a table cell', async () => {
    const source = tempDir('marmeon-docs-source-');
    mkdirSync(join(source, 'docs'));
    writeFileSync(join(source, 'docs/one.md'), '# One\n\n| a | b |\n| - | - |\n| x | [u](../UPGRADING.md) |\n');
    writeFileSync(join(source, 'UPGRADING.md'), '# Upgrading\n');
    const docs = { sections: [{ title: 'Basics', pages: [{ slug: 'one', label: 'One' }, { slug: 'upgrading', label: 'Up', file: 'UPGRADING.md' }] }] };
    const repository = await new DocsRepository({ source, docs }).load();
    expect(repository.doc('one')!.markdown).toContain('[u](upgrading.md)');
  });

  it('is a 404 for anything that is not a listed page', async () => {
    for (const path of ['/docs/search.md', '/docs/no-such-page.md', '/docs/Routing.md', '/docs/routing.md.md', '/docs/..%2FREADME.md', '/docs/.md', '/README.md', '/UPGRADING.md']) {
      await app.get(path).assertNotFound();
    }
  });

  it('builds the canonical link from APP_URL, never from the request’s host', async () => {
    await expectOriginFromAppUrl('/docs/routing.md', (response) => response.headers.get('link'), '<https://docs.example/docs/routing>; rel="canonical"');
  });

  it('stops the start when a page has a link the scanner cannot place', async () => {
    const source = tempDir('marmeon-docs-source-');
    mkdirSync(join(source, 'docs'));
    writeFileSync(join(source, 'docs/one.md'), '# One\n\n[a][r]\n\n[r]: other.md\n');
    const docs = { sections: [{ title: 'Basics', pages: [{ slug: 'one', label: 'One' }] }] };
    const error = await new DocsRepository({ source, docs }).load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocsError);
    expect((error as DocsError).problems.join('\n')).toMatch(/docs\/one\.md: .*write links inline/);
  });
});
