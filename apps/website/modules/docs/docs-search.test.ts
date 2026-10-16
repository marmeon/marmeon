import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { SearchController } from './controllers/SearchController.ts';
import { results } from './docs.test-support.ts';
import { SSR_TEST_TIMEOUT } from './test-timeouts.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
}, 30_000);
afterAll(() => server?.close());

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application);
}, 30_000);
afterAll(() => app?.close());

// Some tests boot apps of their own (server-rendered, throttled): slow on a busy machine.
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
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
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
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
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
