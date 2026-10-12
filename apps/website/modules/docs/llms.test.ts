import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import docsConfig from '../../docs.config.ts';
import { expectOriginFromAppUrl } from '../site/origin.test-support.ts';
import { SiteInfo } from '../site/SiteInfo.ts';
import { DocsRepository } from './DocsRepository.ts';
import { llmsIndex } from './llms.ts';
import { markdownParser } from './markdown.ts';

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application);
});

const SECTIONS = docsConfig.sections;
const SLUGS = SECTIONS.flatMap((section) => section.pages.map((entry) => entry.slug));

describe('/llms.txt', () => {
  it('lists every section and page, in order, each linked to its Markdown', async () => {
    const response = await app.get('/llms.txt').assertOk();
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);
    expect(response.headers.get('etag')).not.toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    const text = response.body;
    expect(text.startsWith('# Marmeon\n\n> Marmeon is')).toBe(true);
    expect([...text.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual(SECTIONS.map((section) => section.title));
    expect([...text.matchAll(/^- \[.*\]\((.+)\)$/gm)].map((match) => match[1])).toEqual(SLUGS.map((slug) => `http://localhost/docs/${slug}.md`));
    expect(text).toContain('- [Database: Getting Started]');
    expect(text).toContain('http://localhost/llms-full.txt');
    expect(text).toContain(app.make(SiteInfo).version);
  });

  it('links pages that answer as Markdown', async () => {
    const urls = [...(await app.get('/llms.txt').assertOk()).body.matchAll(/^- \[.*\]\((.+)\)$/gm)].map((match) => new URL(match[1]!).pathname);
    for (const path of urls) expect((await app.get(path).assertOk()).headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  }, 60_000);

  it('takes its origin from APP_URL, not from the request', async () => {
    await expectOriginFromAppUrl('/llms.txt', (response) => /\((https[^)]*)\)/.exec(response.body)?.[1] ?? null, 'https://docs.example/docs/why-marmeon.md');
  });

  it('leaves an empty section out and escapes brackets in a title', () => {
    const text = llmsIndex('H\n', [{ title: 'Empty', pages: [] }, { title: 'S', pages: [{ title: 'A [b]', url: 'http://x/y.md' }] }]);
    expect(text).not.toContain('Empty');
    expect(text).toContain('- [A \\[b\\]](http://x/y.md)');
  });
});

describe('/llms-full.txt', () => {
  it('holds every page in order, with absolute links and untouched code', async () => {
    const response = await app.get('/llms-full.txt').assertOk();
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('set-cookie')).toBeNull();
    const text = response.body;
    const docs = app.make(DocsRepository);
    const sources = [...text.matchAll(/^<!-- Source: (.+) -->$/gm)].map((match) => match[1]);
    expect(sources).toEqual(SLUGS.map((slug) => `http://localhost/docs/${slug}.md`));
    let at = 0;
    for (const slug of SLUGS) {
      const next = text.indexOf(`<!-- Source: http://localhost/docs/${slug}.md -->\n\n# ${docs.doc(slug)!.title}`, at);
      expect(next, slug).toBeGreaterThanOrEqual(at);
      at = next;
    }
    const relative: string[] = [];
    for (const token of markdownParser.parse(text, {}).flatMap((block) => block.children ?? [])) {
      const href = String(token.attrGet('href'));
      if (token.type === 'link_open' && !/^[a-z][a-z0-9+.-]*:/i.test(href)) relative.push(href);
    }
    expect(relative).toEqual([]);
    expect(text).toContain('](http://localhost/docs/routing.md#');
    expect(text).toContain('/blob/main/README.md#principles');
    const snippet = /```ts[^\n]*\n([^`]{20,200})\n```/.exec(await readRouting())![1]!;
    expect(text).toContain(snippet);
    const again = await app.get('/llms-full.txt', { headers: { 'if-none-match': response.headers.get('etag')! } });
    expect(again.status).toBe(304);
  });

  it('takes its origin from APP_URL, not from the request', async () => {
    await expectOriginFromAppUrl('/llms-full.txt', (response) => /^<!-- Source: (.*) -->$/m.exec(response.body)?.[1] ?? null, 'https://docs.example/docs/why-marmeon.md');
  });
});

describe('DocsRepository.markdownPages', () => {
  it('is computed once per origin', () => {
    const docs = app.make(DocsRepository);
    const url = (path: string) => `http://localhost${path}`;
    const first = docs.markdownPages(url, 'http://localhost');
    expect(docs.markdownPages(url, 'http://localhost')).toBe(first);
    expect(docs.markdownPages((path) => `https://other${path}`, 'https://other')).not.toBe(first);
  });
});

async function readRouting(): Promise<string> {
  const { readFileSync } = await import('node:fs');
  return readFileSync(new URL('../../../../docs/routing.md', import.meta.url), 'utf8');
}
