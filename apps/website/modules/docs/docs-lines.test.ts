import { join } from 'node:path';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { DocsRepository } from './DocsRepository.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

// One line, 0.9.x, with three pages, UPGRADING.md and its index — the website's own repository pins none yet.
const fixture = join(import.meta.dirname, '__fixtures__/lines');
const lines = { DOCS_LINES: join(fixture, 'snapshots'), DOCS_LINE_PINS: join(fixture, 'docs-lines.json') };
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const html = { headers: { accept: 'text/html' } };

let app: TestApp;
let withLines: TestApp;
let withoutLines: TestApp;
beforeAll(async () => {
  app = await createTestApp(application, { env: lines, ssr: true, ssrServer: server });
  withLines = await createTestApp(application, { env: lines });
  // Whatever the repository pins: a missing directory and file are "no lines".
  withoutLines = await createTestApp(application, { env: { DOCS_LINES: '/nonexistent/lines', DOCS_LINE_PINS: '/nonexistent/docs-lines.json' } });
});
afterAll(async () => {
  await Promise.all([app?.close(), withLines?.close(), withoutLines?.close()]);
});

const tag = (body: string, kind: 'meta' | 'link', key: string, value: string) =>
  [...body.matchAll(new RegExp(`<${kind} [^>]*>`, 'g'))].map((match) => match[0]).filter((found) => found.includes(` ${key}="${value}"`));
const hrefOf = (found: string | undefined) => /href="([^"]*)"/.exec(found ?? '')?.[1];

describe('a page of a release line', () => {
  it('is served from the snapshot, with a banner, noindex and the newest version of the page as canonical', async () => {
    const response = await app.get('/docs/0.9.x/routing', html).assertOk().assertServerRendered();
    const body = response.body;
    expect(body).toContain('Routing of the line');
    // React puts a comment between the text and an expression in server-rendered HTML.
    const text = body.replace(/<!-- -->/g, '');
    expect(text).toContain('Marmeon 0.9.0 — the documentation of the 0.9.x line. The newest version of this page:');
    expect(tag(body, 'meta', 'name', 'robots')).toHaveLength(1);
    expect(body).toMatch(/<meta name="robots" content="noindex"/);
    expect(tag(body, 'link', 'rel', 'canonical').map(hrefOf)).toEqual(['http://localhost/docs/routing']);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(body).not.toContain('data-search-trigger');
    expect(text).toMatch(/<span class="badge">0\.9\.0<\/span>/);
    expect(body).toContain('href="/docs/0.9.x/middleware"');
  });

  it('says the same on the start of a line: one noindex, the start of the docs as canonical, the header', async () => {
    const response = await app.get('/docs/0.9.x', html).assertOk().assertServerRendered();
    expect(tag(response.body, 'meta', 'name', 'robots')).toHaveLength(1);
    expect(response.body).toMatch(/<meta name="robots" content="noindex"/);
    expect(tag(response.body, 'link', 'rel', 'canonical').map(hrefOf)).toEqual(['http://localhost/docs']);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.body).not.toContain('data-search-trigger');
  });

  it('names the start of the docs as canonical when the newest docs no longer have the page', async () => {
    const body = (await app.get('/docs/0.9.x/retired-feature', html).assertOk()).body;
    expect(tag(body, 'link', 'rel', 'canonical').map(hrefOf)).toEqual(['http://localhost/docs']);
    expect(body).toMatch(/<meta name="robots" content="noindex"/);
    expect(app.make(DocsRepository).doc('retired-feature')).toBeUndefined();
  });

  it('carries the line, its own navigation and the pager of the line as props', async () => {
    const page = (await withLines.navigating().get('/docs/0.9.x/routing').assertOk()).page()!;
    expect(page.props).toMatchObject({
      title: 'Routing of the line',
      newest: '/docs/routing',
      markdown: '/docs/0.9.x/routing.md',
      line: { name: '0.9.x', version: '0.9.0' },
      previous: null,
      next: { path: '/docs/0.9.x/middleware' },
    });
    const nav = page.props.lineNav as { groups: { title: string; pages: { path: string }[] }[] };
    expect(nav.groups.map((group) => group.title)).toEqual(['The Basics', 'Legacy']);
    expect(nav.groups.flatMap((group) => group.pages.map((entry) => entry.path))).toEqual([
      '/docs/0.9.x/routing',
      '/docs/0.9.x/middleware',
      '/docs/0.9.x/retired-feature',
      '/docs/0.9.x/upgrade',
    ]);
    expect(page.props.nav).toBeUndefined();
  });

  it('serves a root file of the line as a page', async () => {
    expect((await withLines.get('/docs/0.9.x/upgrade.md').assertOk()).body).toBe('> Marmeon 0.9.0, the 0.9.x line. The newest documentation: http://localhost/docs\n\n# Upgrading\n\nChanges of the line.\n');
  });

  it('lists the line on the start of the docs', async () => {
    const page = (await withLines.navigating().get('/docs').assertOk()).page()!;
    expect(page.props.lines).toEqual([{ name: '0.9.x', version: '0.9.0', path: '/docs/0.9.x' }]);
  });
});

describe('the Markdown of a release line', () => {
  it('rewrites links within the line and sends a file that is no page to GitHub at the pinned commit', async () => {
    const response = await withLines.get('/docs/0.9.x/routing.md').assertOk();
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('link')).toBe('<http://localhost/docs/routing>; rel="canonical"');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.body.startsWith('> Marmeon 0.9.0, the 0.9.x line. The newest version of this page: http://localhost/docs/routing\n\n# Routing of the line\n')).toBe(true);
    expect(response.body).toContain('](middleware.md#order)');
    expect(response.body).toContain(`](https://github.com/marmeon/marmeon/blob/${COMMIT}/README.md#principles)`);
    expect(response.body).not.toContain('/blob/main/');
  });

  it('names /docs as canonical for a page the newest docs no longer have', async () => {
    const response = await withLines.get('/docs/0.9.x/retired-feature.md').assertOk();
    expect(response.headers.get('link')).toBe('<http://localhost/docs>; rel="canonical"');
    expect(response.body.startsWith('> Marmeon 0.9.0, the 0.9.x line. The newest documentation: http://localhost/docs\n\n# A retired feature\n')).toBe(true);
  });

  it('is what a client that asks for Markdown gets on the HTML URLs, with Vary: Accept', async () => {
    const page = await withLines.get('/docs/0.9.x/routing', { headers: { accept: 'text/markdown' } }).assertOk();
    expect(page.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(page.headers.get('vary')).toContain('Accept');
    expect(page.body.startsWith('> Marmeon 0.9.0, the 0.9.x line.')).toBe(true);
    const home = await withLines.get('/docs/0.9.x', { headers: { accept: 'text/markdown' } }).assertOk();
    expect(home.body).toContain('Marmeon 0.9.0, the 0.9.x line,');
    expect(home.body).toContain('http://localhost/docs/0.9.x/routing.md');
  });
});

describe('llms.txt of a release line', () => {
  it('names the line and links only pages under /docs/<line>/', async () => {
    const response = await withLines.get('/docs/0.9.x/llms.txt').assertOk();
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('link')).toBe('<http://localhost/llms.txt>; rel="canonical"');
    expect(response.body).toContain('Marmeon 0.9.0, the 0.9.x line,');
    expect(response.body).toContain('This is not the newest documentation, which is at http://localhost/llms.txt');
    const urls = [...response.body.matchAll(/^- \[.*\]\((.+)\)$/gm)].map((match) => match[1]);
    expect(urls).toEqual([
      'http://localhost/docs/0.9.x/routing.md',
      'http://localhost/docs/0.9.x/middleware.md',
      'http://localhost/docs/0.9.x/retired-feature.md',
      'http://localhost/docs/0.9.x/upgrade.md',
    ]);
    expect(response.body).not.toContain('http://localhost/docs/routing');
  });

  it('puts every page of the line into llms-full.txt, links absolute, nothing of the newest docs', async () => {
    const response = await withLines.get('/docs/0.9.x/llms-full.txt').assertOk();
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('link')).toBe('<http://localhost/llms-full.txt>; rel="canonical"');
    const sources = [...response.body.matchAll(/^<!-- Source: (.+) -->$/gm)].map((match) => match[1]);
    expect(sources).toEqual([
      'http://localhost/docs/0.9.x/routing.md',
      'http://localhost/docs/0.9.x/middleware.md',
      'http://localhost/docs/0.9.x/retired-feature.md',
      'http://localhost/docs/0.9.x/upgrade.md',
    ]);
    expect(response.body).toContain('](http://localhost/docs/0.9.x/middleware.md#order)');
    expect(response.body).not.toContain('# Routing\n');
  });

  it('is named in /llms.txt, which otherwise lists the newest docs only', async () => {
    const body = (await withLines.get('/llms.txt').assertOk()).body;
    expect(body).toContain('## Release lines\n\n- [Marmeon 0.9.0 (0.9.x)](http://localhost/docs/0.9.x/llms.txt)\n');
    expect(body.indexOf('## Release lines')).toBeGreaterThan(body.indexOf('## Tools'));
    expect(body).not.toContain('retired-feature');
  });

  it('is left out of the sitemap', async () => {
    const body = (await withLines.get('/sitemap.xml').assertOk()).body;
    expect(body).toContain('<loc>http://localhost/docs/routing</loc>');
    expect(body).not.toContain('0.9.x');
  });
});

describe('what is not a page of a release line is a 404', () => {
  it.each([
    '/docs/0.9.y/routing',
    '/docs/0.8.x/routing',
    '/docs/1.x/routing',
    '/docs/1.x',
    '/docs/0.9.x/nope',
    '/docs/0.9.x/nope.md',
    '/docs/0.9.x/search',
    '/docs/0.9.x/..%2Fx',
    '/docs/0.9.x/%2e%2e',
    '/docs/0.9.x/%2e%2e%2f%2e%2e%2fpackage.json',
    '/docs/0.9.x/docs%2Frouting',
    '/docs/0.9.x/routing.md%00',
    '/docs/0.9.x/routing%00',
    '/docs/0.9.x/index.json',
    '/docs/0.9.x/Routing',
    '/docs/0.9.x/routing/extra',
    '/docs/0.9.x/UPGRADING.md',
    '/docs/0.9.x/__proto__',
    '/docs/0.9.x/constructor.md',
    '/docs/0.09.x/routing',
    '/docs/0.9.x%2Frouting',
    '/docs/0.9.x/llms.txt.md',
  ])('%s', async (path) => {
    await withLines.get(path).assertNotFound();
    await withLines.get(path, { headers: { accept: 'text/markdown' } }).assertNotFound();
  });

  it('is the same for a query, a header or a forged host: the content is the snapshot or the newest docs, nothing else', async () => {
    const odd = await withLines.get('/docs/0.9.x/routing.md?file=../../../../package.json&line=0.3.x', {
      headers: { host: 'evil.invalid', 'x-forwarded-host': 'evil.invalid', 'x-original-url': '/docs/routing.md', 'x-rewrite-url': '/package.json', accept: 'text/markdown' },
    }).assertOk();
    expect(odd.body.endsWith('\n\n# Routing of the line\n\nThe routes of the line, as they were written then.\n\n## Named routes\n\nSee [middleware](middleware.md#order) and the [readme](https://github.com/marmeon/marmeon/blob/' + COMMIT + '/README.md#principles).\n')).toBe(true);
    expect(odd.headers.get('link')).toBe('<http://localhost/docs/routing>; rel="canonical"');
    expect(JSON.stringify([...odd.headers])).not.toContain('evil.invalid');
    expect(odd.body).not.toContain('evil.invalid');
    const newest = (await withLines.get('/docs/routing.md?line=0.9.x', { headers: { 'x-original-url': '/docs/0.9.x/routing.md' } }).assertOk()).body;
    expect(newest.startsWith('# Routing\n')).toBe(true);
  });
});

describe('without pins nothing changes', () => {
  it('has no line: its URLs are 404s and /docs and /llms.txt name none', async () => {
    await withoutLines.get('/docs/0.9.x/routing').assertNotFound();
    await withoutLines.get('/docs/0.3.x').assertNotFound();
    await withoutLines.get('/docs/0.3.x/llms.txt').assertNotFound();
    expect((await withoutLines.get('/llms.txt').assertOk()).body).not.toContain('Release lines');
    expect((await withoutLines.navigating().get('/docs').assertOk()).page()!.props.lines).toEqual([]);
    expect((await withoutLines.get('/docs/routing.md').assertOk()).body.startsWith('# Routing\n')).toBe(true);
  });
});
