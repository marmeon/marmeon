import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import docsConfig, { PACKAGES } from '../../docs.config.ts';
import type { SearchController } from './controllers/SearchController.ts';
import { DocsError, DocsRepository } from './DocsRepository.ts';
import { createCodeHighlighter } from './highlight.ts';
import { CachePublicly } from './middleware/CachePublicly.ts';
import { DocsConfig } from '../../config/docs.ts';
import type { SearchResult } from './search.ts';

// Slow under load (it hit Vitest's 5 s on a fully loaded machine): more time on CI runners only (CI=true, W8 step 1).
const ciTimeout = process.env.CI === 'true' ? 15_000 : undefined;

const repo = resolve(import.meta.dirname, '../../../..');
let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application);
});

const results = (response: { page(): { props: unknown } | undefined }) => (response.page()!.props as { results: SearchResult[] }).results;

describe('the search (a server route, E133)', () => {
  it('finds onOneServer() on the scheduler page and TracingChannel on core’s — anchors into the section', async () => {
    const scheduler = results(await app.navigating().get('/search?q=onOneServer').assertOk().assertPage('docs/Search'));
    expect(scheduler[0]!.href).toMatch(/^\/packages\/scheduler(#|$)/);
    expect(scheduler.some((result) => result.href.startsWith('/packages/scheduler'))).toBe(true);
    const core = results(await app.navigating().get('/search?q=TracingChannel').assertOk());
    expect(core[0]!.href).toMatch(/^\/packages\/core#/);
    expect(core[0]!.excerpt.toLowerCase()).toContain('tracingchannel');
  });

  it('takes all words, case-insensitively, at most 20 hits', async () => {
    const hits = results(await app.navigating().get('/search?q=QUEUE%20worker').assertOk());
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(20);
    expect(results(await app.navigating().get('/search?q=onOneServer%20xyzzy').assertOk())).toEqual([]);
  });

  it('typing reloads only the results — a partial reload of the page on screen', async () => {
    const response = await app.reloading<SearchController>('docs/Search', { only: ['results'] }).get('/search?q=scheduler').assertOk();
    expect(Object.keys(response.page()!.props)).toEqual(['results']);
  });

  it('a query over 100 characters is invalid and falls back to the empty search (E56: no 422, no 500, no work)', async () => {
    const response = await app.navigating().get(`/search?q=${'onOneServer'.repeat(910)}`).assertOk();
    expect(results(response)).toEqual([]);
    // The invalid value is dropped: the page's query is empty, its default the empty search.
    expect(response.page()!.query).toEqual({});
    expect(response.page()!.queryDefaults).toEqual({ q: '' });
  });

  it('is throttled per client (the route’s limiter, DOCS_SEARCH_PER_MINUTE)', async () => {
    const limited = await createTestApp(application, { env: { DOCS_SEARCH_PER_MINUTE: '2' } });
    await limited.get('/search?q=a').assertOk();
    await limited.get('/search?q=b').assertOk();
    await limited.get('/search?q=c').assertStatus(429);
  });
});

describe('pages', () => {
  it('an unknown package is a 404 (the repository binds the route)', async () => {
    await app.get('/packages/no-such-package').assertNotFound();
    await app.get('/packages/core').assertOk().assertPage('docs/Page');
  });

  it('a path without a route is a 404 page in the layout — without the navigation (no shared props there), rendered on the server', async () => {
    const ssr = await createTestApp(application, { ssr: true });
    const response = await ssr.get('/no/such/page', { headers: { accept: 'text/html' } }).assertNotFound().assertServerRendered();
    expect(response.body).toContain('Not Found');
    expect(response.body).toContain('class="frame bare"');
    expect(response.body).not.toContain('id="sidebar"');
  });

  it('shares the navigation — every package in its group — once per tab', async () => {
    const page = (await app.navigating().get('/packages/http').assertOk()).page()!;
    const nav = page.props.nav as { groups: { title: string; pages: { name: string; label: string; path: string }[] }[] };
    expect(nav.groups.map((group) => group.title)).toEqual(['Guides', 'Core', 'HTTP', 'Data', 'Auth & Mail', 'Background', 'Frontend', 'Tools']);
    expect(nav.groups.slice(1).flatMap((group) => group.pages.map((pkg) => pkg.name)).sort()).toEqual([...PACKAGES].sort());
    expect(nav.groups[0]!.pages.map((guide) => guide.path)).toEqual(docsConfig.guides!.map((guide) => `/guides/${guide.slug}`));
    expect(page.props).toMatchObject({ previous: { path: '/packages/router' }, next: { path: '/packages/server' }, group: 'HTTP', title: '@marmeon/http' });
  });
});

describe('the guides (docs/*.md and the policies at the root, E168)', () => {
  it('are pages under /guides — with their own neighbours, in the search, and an unknown one is a 404', async () => {
    const deployment = (await app.navigating().get('/guides/deployment').assertOk().assertPage('docs/Page')).page()!;
    expect(deployment.props).toMatchObject({ title: 'Deploying a Marmeon app', group: 'Guides', previous: { path: '/guides/realtime' }, next: { path: '/guides/security' } });
    const upgrading = (await app.navigating().get('/guides/upgrading').assertOk()).page()!;
    expect(upgrading.props).toMatchObject({ title: 'Upgrading' });
    await app.get('/guides/no-such-guide').assertNotFound();
    await app.get('/guides/README').assertNotFound();
    const hits = results(await app.navigating().get('/search?q=SHUTDOWN_DELAY').assertOk());
    expect(hits.some((hit) => hit.href.startsWith('/guides/deployment'))).toBe(true);
  });

  it('a link of a README to a guide is a visit to its page, with the anchor (no longer code text)', async () => {
    const docs = app.make(DocsRepository);
    const home = JSON.stringify(docs.home().body);
    expect(home).toContain('"href":"/guides/deployment","data-internal":""');
    expect(home).toContain('"href":"/guides/upgrading","data-internal":""');
    expect(docs.pages().flatMap((page) => page.fileLinks).filter((file) => /^docs\/|^[A-Z]+\.md$/.test(file))).toEqual([]);
  });
});

describe('public pages: no cookie, cacheable — and a cache can tell the document from its JSON', () => {
  const document = { headers: { accept: 'text/html' } };

  it('sets no cookie, on any page — the docs group has no session, no CSRF, no encrypted cookies', async () => {
    for (const path of ['/', '/packages/session', '/guides/security', '/search?q=csrf']) {
      const response = await app.get(path, document).assertOk();
      expect(response.headers.get('set-cookie'), path).toBeNull();
      expect(response.headers.get('cache-control'), path).toMatch(/^public, max-age=300$/);
    }
    expect((await app.navigating().get('/').assertOk()).headers.get('set-cookie')).toBeNull();
  });

  it('answers a revalidation with 304 — and the document and the page object differ in ETag, with Vary naming the headers', async () => {
    const html = await app.get('/packages/queue', document).assertOk();
    const json = await app.navigating().get('/packages/queue').assertOk();
    const etag = html.headers.get('etag')!;
    expect(etag).toMatch(/^"[\w-]{27}"$/);
    expect(json.headers.get('etag')).not.toBe(etag);
    for (const response of [html, json]) {
      const vary = response.headers.get('vary')!.toLowerCase().split(/\s*,\s*/);
      expect(vary).toEqual(expect.arrayContaining(['x-marmeon', 'x-marmeon-partial-component', 'x-marmeon-partial-data', 'x-marmeon-partial-except', 'purpose', 'x-marmeon-once', 'x-marmeon-version']));
    }
    const again = await app.get('/packages/queue', { headers: { accept: 'text/html', 'if-none-match': `W/${etag}` } });
    expect(again.status).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect((await app.get('/packages/queue', { headers: { accept: 'text/html', 'if-none-match': '"other"' } })).status).toBe(200);
  });

  it('in development a page is no-cache: an edited README shows on the next visit', async () => {
    const dev = await createTestApp(application, { env: { NODE_ENV: 'development', DOCS_SOURCE: repo } });
    const response = await dev.get('/', document).assertOk();
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it("a cached page's policy has no nonce ('self'); in development — nothing cached — Vite's inline scripts get the strict nonce policy", async () => {
    const ssr = await createTestApp(application, { ssr: true });
    const first = await ssr.get('/packages/http', document).assertOk();
    const second = await ssr.get('/packages/http', document).assertOk();
    expect(first.headers.get('content-security-policy')).toBe("script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    // No nonce attribute on a tag (the http README's text mentions `nonce=` — escaped, inside the page).
    expect(first.body).not.toMatch(/<[a-z]+ [^>]*\bnonce=/);
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
    // The 404 page (no route, no group) is a document too.
    const missing = await ssr.get('/no/such/page', document);
    expect(missing.headers.get('content-security-policy')).toMatch(/^script-src 'self';/);
    // Never sniffed, no full URL to other sites, never framed — pages and the 404 alike (HSTS: the proxy).
    for (const answer of [first, missing]) {
      expect(Object.fromEntries(['x-content-type-options', 'referrer-policy', 'x-frame-options'].map((name) => [name, answer.headers.get(name)]))).toEqual({
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'x-frame-options': 'DENY',
      });
    }
    // JSON visits carry no policy (it is for documents).
    expect((await ssr.navigating().get('/packages/http').assertOk()).headers.get('content-security-policy')).toBeNull();
    const dev = await createTestApp(application, { env: { NODE_ENV: 'development', DOCS_SOURCE: repo } });
    expect((await dev.get('/', document).assertOk()).headers.get('content-security-policy')).toMatch(/^script-src 'nonce-[\w+/=-]+' 'strict-dynamic'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'$/);
  });

  it('never marks an answer with a cookie public (a cache would hand the cookie to everyone)', async () => {
    const config = app.make(DocsConfig);
    const request = new Request('http://localhost/');
    const answer = (headers: Record<string, string>) => async () => new Response('page', { headers });
    const ctx = { request } as Parameters<CachePublicly['handle']>[0];
    const withCookie = await new CachePublicly(config).handle(ctx, answer({ 'set-cookie': 'a=b' }));
    expect(withCookie.headers.get('cache-control')).toBeNull();
    expect(withCookie.headers.get('etag')).toBeNull();
    const noStore = await new CachePublicly(config).handle(ctx, answer({ 'cache-control': 'no-store' }));
    expect(noStore.headers.get('cache-control')).toBe('no-store');
    const plain = await new CachePublicly(config).handle(ctx, answer({}));
    expect(plain.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('leaves a 404 alone (no public caching of errors)', async () => {
    const response = await app.get('/packages/nope', document);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control') ?? '').not.toMatch(/public/);
    expect(response.headers.get('etag')).toBeNull();
  });
});

describe('the repository and docs.config.ts', () => {
  /** A copy of the repository's READMEs — the real ones are never touched. */
  function copy(): string {
    const dir = mkdtempSync(join(tmpdir(), 'marmeon-docs-'));
    cpSync(join(repo, 'README.md'), join(dir, 'README.md'));
    for (const name of PACKAGES) {
      mkdirSync(join(dir, 'packages', name), { recursive: true });
      cpSync(join(repo, 'packages', name, 'README.md'), join(dir, 'packages', name, 'README.md'));
      writeFileSync(join(dir, 'packages', name, 'package.json'), '{}');
    }
    mkdirSync(join(dir, 'docs'));
    for (const guide of docsConfig.guides!) cpSync(join(repo, guide.file), join(dir, guide.file));
    return dir;
  }

  it('stops the start for a docs/*.md without its entry in the guides — and for a listed guide that is gone', async () => {
    const dir = copy();
    try {
      writeFileSync(join(dir, 'docs/brandnew.md'), '# Brand new\n');
      rmSync(join(dir, 'SECURITY.md'));
      const error = await new DocsRepository({ source: dir }).load().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DocsError);
      expect((error as DocsError).problems).toEqual([
        `docs.config.ts lists the guide SECURITY.md, but it does not exist in ${dir}.`,
        'docs/brandnew.md has no entry in docs.config.ts — add it to the guides.',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, ciTimeout);

  it('stops the start for a package without its place in docs.config.ts — and for a package without a README', async () => {
    const dir = copy();
    try {
      await new DocsRepository({ source: dir }).load();
      mkdirSync(join(dir, 'packages/brandnew'));
      writeFileSync(join(dir, 'packages/brandnew/package.json'), '{}');
      writeFileSync(join(dir, 'packages/brandnew/README.md'), '# @marmeon/brandnew\n');
      rmSync(join(dir, 'packages/otel/README.md'));
      const error = await new DocsRepository({ source: dir }).load().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DocsError);
      expect((error as DocsError).problems).toEqual([
        "packages/brandnew/README.md has no entry in docs.config.ts — add 'brandnew' to PACKAGES and to a group.",
        'packages/otel has no README.md — every package documents itself.',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, ciTimeout);

  it('shows raw HTML of a README as text — a <script> never reaches the page as markup (server-rendered)', async () => {
    const dir = copy();
    try {
      appendFileSync(join(dir, 'packages/core/README.md'), "\n<script>alert('readme')</script>\n\nInline <img src=x onerror=alert(1)> too.\n");
      const ssr = await createTestApp(application, { ssr: true, env: { DOCS_SOURCE: dir } });
      const response = await ssr.get('/packages/core', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
      const content = response.body.slice(response.body.indexOf('<div id="app">'));
      expect(content).toContain('&lt;script&gt;alert(&#x27;readme&#x27;)&lt;/script&gt;');
      expect(content).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(content).not.toMatch(/<script>alert|<img src=x/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the app does not boot then', async () => {
    const dir = copy();
    try {
      rmSync(join(dir, 'README.md'));
      await expect(createTestApp(application, { env: { DOCS_SOURCE: dir } })).rejects.toThrow(/README\.md is missing — the start page/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('highlights every code block of every README with the stylesheet’s token classes (no inline colours left)', async () => {
    const highlighter = await createCodeHighlighter();
    const docs = await new DocsRepository({ source: repo }).load();
    expect(docs.pages().length).toBe(PACKAGES.length + 1 + docsConfig.guides!.length);
    expect(highlighter.highlight("import { x } from 'y';", 'ts')).toBe(
      '<pre class="code" tabindex="0" data-lang="ts"><code><span class="line"><span class="tk">import</span> { x } <span class="tk">from</span><span class="ts"> \'y\'</span>;</span></code></pre>',
    );
    // Every colour of every README's code is one of TOKEN_CLASSES (styles/docs.css has both themes for them).
    expect(JSON.stringify(docs.pages().map((page) => page.body))).not.toContain('style=');
  });
});
