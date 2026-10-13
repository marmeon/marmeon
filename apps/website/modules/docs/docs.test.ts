import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import docsConfig, { type DocsPageEntry } from '../../docs.config.ts';
import type { SearchController } from './controllers/SearchController.ts';
import { DocsError, DocsRepository, type Navigation } from './DocsRepository.ts';
import { SiteConfig } from '../../config/site.ts';
import { CachePublicly } from '../site/middleware/CachePublicly.ts';
import { PENDING_MARKER } from './markdown.ts';
import type { SearchResult } from './search.ts';
import { SSR_TEST_TIMEOUT } from './test-timeouts.ts';

// Vitest's 5 s is too short under load: more time on CI runners only (CI=true).
const ciTimeout = process.env.CI === 'true' ? 15_000 : undefined;

const repo = resolve(import.meta.dirname, '../../../..');
let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application);
}, 30_000);

/** Every page of the docs in the order of docs.config.ts — across the sections. */
const ENTRIES = docsConfig.sections.flatMap((section) => section.pages);
const fileOf = (entry: DocsPageEntry) => entry.file ?? `docs/${entry.slug}.md`;
const SECTIONS = [
  'Prologue',
  'Getting Started',
  'Architecture Concepts',
  'The Basics',
  'Frontend',
  'Digging Deeper',
  'Security',
  'Database',
  'Testing',
  'Tools',
];

const results = (response: { page(): { props: unknown } | undefined }) => (response.page()!.props as { results: SearchResult[] }).results;

// Each test boots the app, some with a Vite server: slow on a busy machine.
describe('the search (a server route)', { timeout: 30_000 }, () => {
  it('finds onOneServer() on the scheduling page and "missed runs" under its heading — anchors into the section', async () => {
    const hits = results(await app.navigating().get('/docs/search?q=onOneServer').assertOk().assertPage('docs/Search'));
    const scheduling = hits.find((result) => result.href.startsWith('/docs/scheduling#'));
    expect(scheduling?.excerpt.toLowerCase()).toContain('ononeserver');
    const missed = results(await app.navigating().get('/docs/search?q=missed%20runs').assertOk());
    expect(missed[0]!.href).toBe('/docs/scheduling#missed-runs');
  });

  it('puts a section that explains a word before code that only uses it: "One server only" among the first three for onOneServer', async () => {
    const hits = results(await app.navigating().get('/docs/search?q=onOneServer').assertOk());
    const at = hits.findIndex((hit) => hit.href === '/docs/scheduling#one-server-only');
    expect(at, JSON.stringify(hits.slice(0, 12).map((hit) => hit.href))).toBeGreaterThanOrEqual(0);
    expect(at, JSON.stringify(hits.slice(0, 12).map((hit) => hit.href))).toBeLessThan(3);
  });

  it('takes all words, case-insensitively, at most 20 hits', async () => {
    const hits = results(await app.navigating().get('/docs/search?q=QUEUE%20worker').assertOk());
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(20);
    expect(results(await app.navigating().get('/docs/search?q=onOneServer%20xyzzy').assertOk())).toEqual([]);
  });

  it('typing reloads only the results — a partial reload of the page on screen', async () => {
    const response = await app.reloading<SearchController>('docs/Search', { only: ['results'] }).get('/docs/search?q=scheduler').assertOk();
    expect(Object.keys(response.page()!.props)).toEqual(['results']);
  });

  it('answers a layer request with the search as a layer, any other request with the page', async () => {
    const layered = await app.layering().get('/docs/search?q=onOneServer').assertOk().assertLayer('docs/Search');
    expect(results(layered).some((hit) => hit.href.startsWith('/docs/scheduling#'))).toBe(true);
    const visited = await app.navigating().get('/docs/search?q=onOneServer').assertOk().assertPage('docs/Search');
    expect(visited.page()!.layer).toBeUndefined();
  });

  it('a partial reload inside the layer answers the layer with the results only', async () => {
    const response = await app.layering().reloading<SearchController>('docs/Search', { only: ['results'] }).get('/docs/search?q=scheduler').assertOk().assertLayer('docs/Search');
    expect(Object.keys(response.page()!.props)).toEqual(['results']);
  });

  it('a document of the search URL has no dialog — the page with its heading and submit button', async () => {
    const ssr = await createTestApp(application, { ssr: true });
    const body = (await ssr.get('/docs/search?q=routing', { headers: { accept: 'text/html' } }).assertOk()).body;
    expect(body).not.toContain('<dialog');
    expect(body).toContain('<h1');
    expect(body).toContain('<button type="submit"');
  }, SSR_TEST_TIMEOUT);

  it('keeps the layer and the page answer of one URL apart in a shared cache: different ETags, Vary names the region', async () => {
    const layer = await app.layering().get('/docs/search?q=onOneServer').assertOk();
    const visit = await app.navigating().get('/docs/search?q=onOneServer').assertOk();
    expect(layer.headers.get('etag')).toMatch(/^"[\w-]{27}"$/);
    expect(layer.headers.get('etag')).not.toBe(visit.headers.get('etag'));
    for (const response of [layer, visit]) {
      expect(response.headers.get('vary')!.toLowerCase().split(/\s*,\s*/)).toContain('x-marmeon-region');
    }
  });

  it('renders the hits grouped by page, with the page’s section, and no hit block without a query', async () => {
    const ssr = await createTestApp(application, { ssr: true });
    const document = { headers: { accept: 'text/html' } };
    const found = (await ssr.get('/docs/search?q=onOneServer', document).assertOk()).body;
    expect(found).toMatch(/<section class="search-group" aria-label="Task Scheduling"><h2><a [^>]*href="\/docs\/scheduling"[^>]*>Task Scheduling<\/a><span class="visually-hidden"> – <\/span><span class="search-section">Digging Deeper<\/span><\/h2>/);
    expect(found).toContain('<button type="submit"');
    const empty = (await ssr.get('/docs/search', document).assertOk()).body;
    expect(empty).not.toContain('search-group');
    expect(empty).toContain('role="status"');
  }, SSR_TEST_TIMEOUT);

  it('a query over 100 characters is invalid and falls back to the empty search (no 422, no 500, no work)', async () => {
    const response = await app.navigating().get(`/docs/search?q=${'onOneServer'.repeat(910)}`).assertOk();
    expect(results(response)).toEqual([]);
    // The invalid value is dropped: the page's query is empty, its default the empty search.
    expect(response.page()!.query).toEqual({});
    expect(response.page()!.queryDefaults).toEqual({ q: '' });
  });

  it('is throttled per client (the route’s limiter, DOCS_SEARCH_PER_MINUTE)', async () => {
    const limited = await createTestApp(application, { env: { DOCS_SEARCH_PER_MINUTE: '2' } });
    await limited.get('/docs/search?q=a').assertOk();
    await limited.get('/docs/search?q=b').assertOk();
    await limited.get('/docs/search?q=c').assertStatus(429);
  });
});

describe('pages', { timeout: 30_000 }, () => {
  it('has no package pages — a package README is a card for npm: /packages/… is a 404', async () => {
    await app.get('/packages/http').assertNotFound();
    await app.get('/packages/core/README.md').assertNotFound();
    await app.navigating().get('/packages/http').assertNotFound();
  });

  it('a path without a route is a 404 page in the site layout — without the navigation (no shared props there), rendered on the server', async () => {
    const ssr = await createTestApp(application, { ssr: true });
    const response = await ssr.get('/no/such/page', { headers: { accept: 'text/html' } }).assertNotFound().assertServerRendered();
    expect(response.body).toContain('Not Found');
    expect(response.body).toContain('class="site-header"');
    expect(response.body).not.toContain('id="sidebar"');
  }, SSR_TEST_TIMEOUT);

  it('shares the navigation — the ten sections with their pages, nothing else — once per tab', async () => {
    const page = (await app.navigating().get('/docs/routing').assertOk()).page()!;
    const nav = page.props.nav as Navigation;
    expect(nav.groups.map((group) => group.title)).toEqual(SECTIONS);
    expect(nav.groups.flatMap((group) => group.pages.map((entry) => entry.path))).toEqual(ENTRIES.map((entry) => `/docs/${entry.slug}`));
    expect(nav.groups.flatMap((group) => group.pages.map((entry) => entry.label))).toEqual(ENTRIES.map((entry) => entry.label));
    expect(page.props).toMatchObject({ previous: { path: '/docs/context' }, next: { path: '/docs/middleware' }, section: 'The Basics', title: 'Routing' });
  });
});

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

describe('the docs: sections of pages under /docs', { timeout: 30_000 }, () => {
  it('lists the 76 pages in ten sections, in this order', () => {
    expect(docsConfig.sections.map((section) => section.title)).toEqual(SECTIONS);
    expect(docsConfig.sections.map((section) => section.pages.length)).toEqual([6, 5, 5, 11, 9, 13, 11, 7, 6, 3]);
    expect(ENTRIES[0]).toEqual({ slug: 'why-marmeon', label: 'Why Marmeon' });
    expect(ENTRIES[1]).toEqual({ slug: 'upgrading', label: 'Upgrade Guide', file: 'UPGRADING.md', changes: true });
    expect(ENTRIES.filter((entry) => entry.file).map((entry) => [entry.slug, entry.file])).toEqual([
      ['upgrading', 'UPGRADING.md'],
      ['contributing', 'CONTRIBUTING.md'],
      ['security-policy', 'SECURITY.md'],
    ]);
  });

  it('answers every page under /docs/<slug> with its title — the file’s # heading — and its section', async () => {
    for (const section of docsConfig.sections) {
      for (const entry of section.pages) {
        const title = /^# (.+)$/m.exec(readFileSync(join(repo, fileOf(entry)), 'utf8'))![1];
        const page = (await app.navigating().get(`/docs/${entry.slug}`).assertOk().assertPage('docs/Page')).page()!;
        expect(page.props, entry.slug).toMatchObject({ title, section: section.title });
      }
    }
  }, 60_000);

  it('an unknown page is a 404 — and the old /guides/ paths are gone', async () => {
    await app.get('/docs/no-such-page').assertNotFound();
    await app.get('/docs/README').assertNotFound();
    await app.get('/guides/deployment').assertNotFound();
  });

  it('the search lives at /docs/search only — the old /search is a 404, not a redirect', async () => {
    await app.get('/search?q=onOneServer').assertNotFound();
    await app.get('/docs/search?q=onOneServer').assertOk();
  });

  it('leads from page to page across the sections — the first has no previous page, the last no next', async () => {
    /** `previous ← page → next`, the pages under /docs by their slugs — short enough that a failure shows the whole line. */
    const neighbours = async (slug: string) => {
      const props = (await app.navigating().get(`/docs/${slug}`).assertOk()).page()!.props as Record<'previous' | 'next', { path: string } | null>;
      const name = (link: { path: string } | null) => link?.path.replace(/^\/docs\//, '') ?? 'none';
      return `${name(props.previous)} ← ${slug} → ${name(props.next)}`;
    };
    expect(await neighbours('deployment')).toBe('starter-kit ← deployment → lifecycle');
    expect(await neighbours('packages')).toBe('security-policy ← packages → installation');
    expect(await neighbours('why-marmeon')).toBe('none ← why-marmeon → upgrading');
    expect(await neighbours('upgrading')).toBe('why-marmeon ← upgrading → releases');
    expect(await neighbours('health')).toBe('observability ← health → none');
  });

  it('the start page lists every docs page exactly once, in its section — and no package page', async () => {
    const page = (await app.navigating().get('/docs').assertOk().assertPage('docs/Home')).page()!;
    const sections = page.props.sections as { title: string; pages: { label: string; path: string }[] }[];
    expect(sections.map((section) => section.title)).toEqual(SECTIONS);
    expect(sections.flatMap((section) => section.pages)).toEqual(ENTRIES.map((entry) => ({ label: entry.label, path: `/docs/${entry.slug}` })));
    expect(JSON.stringify(sections)).not.toContain('/packages/');
  });

  it('the start page links the three first steps to existing pages and shows the terminal without a copy button', async () => {
    const docs = app.make(DocsRepository);
    const ssr = await createTestApp(application, { ssr: true });
    const html = (await ssr.get('/docs', { headers: { accept: 'text/html' } }).assertOk()).body;
    for (const slug of ['installation', 'structure', 'routing']) {
      expect(docs.doc(slug), slug).toBeDefined();
      expect(html).toContain(`href="/docs/${slug}"`);
    }
    expect(html).toContain('pnpm create marmeon my-app');
    expect(html).toContain('class="terminal"');
    expect(html).not.toContain('copy-button');
  }, SSR_TEST_TIMEOUT);

  it('finds the release policy’s sections — and the record of changes comes after every other hit', async () => {
    // "likely" scores the same in the upgrade guide and in the release policy's "How to upgrade": by order alone the guide, the
    // first page of the navigation, would come first.
    const hits = results(await app.navigating().get('/docs/search?q=likely').assertOk());
    expect(hits.some((hit) => hit.href.startsWith('/docs/releases'))).toBe(true);
    const late = hits.map((hit) => hit.href.startsWith('/docs/upgrading'));
    expect(late).toContain(true);
    expect(late.indexOf(true)).toBeGreaterThan(late.lastIndexOf(false));
  });

  it('a link of a page to another page is a visit to it, with the anchor; a link to the root README stays code text', async () => {
    const docs = app.make(DocsRepository);
    const tables = JSON.stringify(docs.doc('tables')!.body);
    expect(tables).toContain('"href":"/docs/requests#how-a-query-is-parsed","data-internal":""');
    expect(docs.pages().flatMap((page) => page.fileLinks).filter((file) => /^docs\/|^[A-Z]+\.md$/.test(file) && file !== 'README.md')).toEqual([]);
    expect(docs.pages().some((page) => page.fileLinks.includes('README.md'))).toBe(true);
  });
});

describe('the content of a page, rendered on the server', { timeout: 30_000 }, () => {
  const document = { headers: { accept: 'text/html' } };
  let ssr: TestApp;
  beforeEach(async () => {
    ssr = await createTestApp(application, { ssr: true });
  }, 30_000);

  it('renders a callout as aside.callout with role="note" and its title', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    expect(html).toMatch(/<aside class="callout [a-z]+" role="note"><p class="callout-title">[A-Za-z]+<\/p>/);
  }, SSR_TEST_TIMEOUT);

  it('renders a code block with a file name as figure.code > figcaption, and a table inside div.table', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    expect(html).toMatch(/<figure class="code"><figcaption><span class="code-caption">modules\/notes\/routes\.ts<\/span>/);
    expect(html).toMatch(/<div class="table"><table>/);
  }, SSR_TEST_TIMEOUT);

  it('links home from the top bar and the footer, and to the docs start page from the "docs" suffix', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    const home = /<a [^>]*href="\/"[^>]*aria-label="Marmeon, home"|<a [^>]*aria-label="Marmeon, home"[^>]*href="\/"/;
    const top = html.slice(html.indexOf('<header class="docs-top"'), html.indexOf('</header>'));
    expect(top).toMatch(home);
    expect(top).toMatch(/<a [^>]*href="\/docs"[^>]*><span class="wordmark-suffix">docs<\/span><\/a>/);
    expect(html.slice(html.indexOf('<footer class="site-footer"'))).toMatch(home);
  }, SSR_TEST_TIMEOUT);

  it('has no copy button in the document: it appears once the page runs in a browser', async () => {
    const html = (await ssr.get('/docs/routing', document).assertOk()).body;
    expect(html).toContain('class="code-block"');
    expect(html).not.toContain('copy-button');
  }, SSR_TEST_TIMEOUT);
});

describe('public pages: no cookie, cacheable — and a cache can tell the document from its JSON', { timeout: 30_000 }, () => {
  const document = { headers: { accept: 'text/html' } };

  it('sets no cookie, on any page — the public group has no session, no CSRF, no encrypted cookies', async () => {
    for (const path of ['/', '/docs', '/docs/session', '/docs/security', '/docs/search?q=csrf']) {
      const response = await app.get(path, document).assertOk();
      expect(response.headers.get('set-cookie'), path).toBeNull();
      expect(response.headers.get('cache-control'), path).toMatch(/^public, max-age=300$/);
    }
    expect((await app.navigating().get('/').assertOk()).headers.get('set-cookie')).toBeNull();
  });

  it('answers a revalidation with 304 — and the document and the page object differ in ETag, with Vary naming the headers', async () => {
    const html = await app.get('/docs/queues', document).assertOk();
    const json = await app.navigating().get('/docs/queues').assertOk();
    const etag = html.headers.get('etag')!;
    expect(etag).toMatch(/^"[\w-]{27}"$/);
    expect(json.headers.get('etag')).not.toBe(etag);
    for (const response of [html, json]) {
      const vary = response.headers.get('vary')!.toLowerCase().split(/\s*,\s*/);
      expect(vary).toEqual(expect.arrayContaining(['x-marmeon', 'x-marmeon-partial-component', 'x-marmeon-partial-data', 'x-marmeon-partial-except', 'purpose', 'x-marmeon-once', 'x-marmeon-version']));
    }
    const again = await app.get('/docs/queues', { headers: { accept: 'text/html', 'if-none-match': `W/${etag}` } });
    expect(again.status).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect((await app.get('/docs/queues', { headers: { accept: 'text/html', 'if-none-match': '"other"' } })).status).toBe(200);
  });

  it('in development a page is no-cache: an edited page shows on the next visit', async () => {
    const dev = await createTestApp(application, { env: { NODE_ENV: 'development', DOCS_SOURCE: repo } });
    const response = await dev.get('/', document).assertOk();
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it("a cached page's policy has no nonce ('self'); in development — nothing cached — Vite's inline scripts get the strict nonce policy", async () => {
    const ssr = await createTestApp(application, { ssr: true });
    const first = await ssr.get('/docs/csp', document).assertOk();
    const second = await ssr.get('/docs/csp', document).assertOk();
    expect(first.headers.get('content-security-policy')).toBe("script-src 'self'; object-src 'none'; base-uri 'self'; style-src 'self'; frame-ancestors 'none'");
    // No nonce attribute on a tag (the CSP page's text mentions `nonce=` — escaped, inside the page).
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
    expect((await ssr.navigating().get('/docs/csp').assertOk()).headers.get('content-security-policy')).toBeNull();
    const dev = await createTestApp(application, { env: { NODE_ENV: 'development', DOCS_SOURCE: repo } });
    expect((await dev.get('/', document).assertOk()).headers.get('content-security-policy')).toMatch(/^script-src 'nonce-[\w+/=-]+' 'strict-dynamic'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'$/);
    // Two more apps, each rendering every page with Shiki when it boots.
  }, SSR_TEST_TIMEOUT);

  it('never marks an answer with a cookie public (a cache would hand the cookie to everyone)', async () => {
    const config = app.make(SiteConfig);
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
    const response = await app.get('/docs/nope', document);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control') ?? '').not.toMatch(/public/);
    expect(response.headers.get('etag')).toBeNull();
  });
});

describe('the repository and docs.config.ts', () => {
  /** A copy of the repository's pages — the real ones are never touched. */
  function copy(): string {
    const dir = mkdtempSync(join(tmpdir(), 'marmeon-website-'));
    mkdirSync(join(dir, 'docs'));
    for (const entry of ENTRIES) cpSync(join(repo, fileOf(entry)), join(dir, fileOf(entry)));
    return dir;
  }

  it('stops the start for a docs/*.md without its entry in a section — and for a listed page whose file is gone', async () => {
    const dir = copy();
    try {
      writeFileSync(join(dir, 'docs/brandnew.md'), '# Brand new\n');
      rmSync(join(dir, 'SECURITY.md'));
      rmSync(join(dir, 'docs/routing.md'));
      const error = await new DocsRepository({ source: dir }).load().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DocsError);
      expect((error as DocsError).problems).toEqual([
        `docs.config.ts lists SECURITY.md, but it does not exist in ${dir}.`,
        `docs.config.ts lists docs/routing.md, but it does not exist in ${dir}.`,
        'docs/brandnew.md has no entry in docs.config.ts — add it to a section.',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, ciTimeout);

  it('stops the start for a slug that is no lower-case words with dashes, a slug or a file listed twice, a file of the wrong place and the root README', async () => {
    const extra: DocsPageEntry[] = [
      { slug: 'Routing_Guide', label: 'Routing guide' },
      { slug: 'routing', label: 'Routing again' },
      { slug: 'upgrade', label: 'Upgrade', file: 'UPGRADING.md' },
      { slug: 'notes', label: 'Notes', file: 'packages/core/README.md' },
      { slug: 'other', label: 'Other', file: 'docs/routing.md' },
      { slug: 'readme', label: 'Readme', file: 'README.md' },
    ];
    const docs = { sections: [...docsConfig.sections, { title: 'More', pages: extra }] };
    const error = await new DocsRepository({ source: repo, docs }).load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocsError);
    expect((error as DocsError).problems).toEqual([
      "The page slug 'Routing_Guide' in docs.config.ts is not lower-case words with dashes.",
      "The page slug 'routing' is listed twice in docs.config.ts.",
      'UPGRADING.md is listed twice in docs.config.ts.',
      "The page 'notes' names packages/core/README.md — a page's file is docs/<slug>.md or a Markdown file at the root.",
      "The page 'other' names docs/routing.md — a page's file is docs/<slug>.md or a Markdown file at the root.",
      "The page 'readme' names README.md — the root README is no page of the docs (the start page is the app's own).",
    ]);
  }, ciTimeout);

  it('refuses the slug "search": /docs/search is the search, a page of that name would be hidden by it', async () => {
    const docs = { sections: [...docsConfig.sections, { title: 'More', pages: [{ slug: 'search', label: 'Search' }] }] };
    const error = await new DocsRepository({ source: repo, docs }).load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocsError);
    expect((error as DocsError).problems).toEqual(["The page slug 'search' is reserved — /docs/search is the search."]);
  }, ciTimeout);

  it('marks a page that carries the pending marker in the navigation — and not one without it', async () => {
    const dir = copy();
    try {
      writeFileSync(join(dir, 'docs/routing.md'), '# Routing\n\nWritten.\n');
      writeFileSync(join(dir, 'docs/middleware.md'), `# Middleware\n${PENDING_MARKER}\n\n> [!NOTE]\n> This page is being written.\n`);
      const docs = await new DocsRepository({ source: dir }).load();
      const entries = docs.navigation().groups.flatMap((group) => group.pages);
      expect(entries.find((entry) => entry.name === 'routing')).toEqual({ name: 'routing', label: 'Routing', path: '/docs/routing' });
      expect(entries.find((entry) => entry.name === 'middleware')).toEqual({ name: 'middleware', label: 'Middleware', path: '/docs/middleware', pending: true });
      expect(docs.doc('routing')!.pending).toBe(false);
      expect(docs.doc('middleware')!.pending).toBe(true);
      expect(JSON.stringify(docs.doc('middleware')!.body)).not.toContain('docs:pending');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, ciTimeout);

  it('shows a page with the pending marker as "draft" in the rendered navigation', async () => {
    const dir = copy();
    try {
      writeFileSync(join(dir, 'docs/middleware.md'), `# Middleware\n${PENDING_MARKER}\n\n> [!NOTE]\n> This page is being written.\n`);
      const ssr = await createTestApp(application, { ssr: true, env: { DOCS_SOURCE: dir } });
      const { body } = await ssr.get('/docs/routing', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
      expect(body).toMatch(/>Middleware<span class="draft">draft<\/span>/);
      expect(body).not.toMatch(/>Routing<span class="draft">/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SSR_TEST_TIMEOUT);

  it('starts without the packages — their READMEs are no pages', async () => {
    const dir = copy();
    try {
      expect(existsSync(join(dir, 'packages'))).toBe(false);
      const docs = await new DocsRepository({ source: dir }).load();
      expect(docs.pages().map((page) => page.file)).toEqual(ENTRIES.map(fileOf));
      expect(JSON.stringify(docs.navigation())).not.toContain('/packages/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, ciTimeout);

  it('shows raw HTML of a page as text — a <script> never reaches the page as markup (server-rendered)', async () => {
    const dir = copy();
    try {
      appendFileSync(join(dir, 'docs/routing.md'), "\n<script>alert('page')</script>\n\nInline <img src=x onerror=alert(1)> too.\n");
      const ssr = await createTestApp(application, { ssr: true, env: { DOCS_SOURCE: dir } });
      const response = await ssr.get('/docs/routing', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered();
      const content = response.body.slice(response.body.indexOf('<div id="app">'));
      expect(content).toContain('&lt;script&gt;alert(&#x27;page&#x27;)&lt;/script&gt;');
      expect(content).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(content).not.toMatch(/<script>alert|<img src=x/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SSR_TEST_TIMEOUT);

  it('the app does not boot then', async () => {
    const dir = copy();
    try {
      rmSync(join(dir, 'docs/routing.md'));
      await expect(createTestApp(application, { env: { DOCS_SOURCE: dir } })).rejects.toThrow(/docs\.config\.ts lists docs\/routing\.md, but it does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('highlights every code block of every page with the stylesheet’s token classes (no inline colours left)', async () => {
    const docs = await new DocsRepository({ source: repo }).load();
    expect(docs.pages().length).toBe(76);
    // Every colour of every page's code is one of TOKEN_CLASSES (styles/code.css has both themes for them).
    expect(JSON.stringify(docs.pages().map((page) => page.body))).not.toContain('style=');
  });
});
