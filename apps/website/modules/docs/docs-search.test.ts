import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { SearchController } from './controllers/SearchController.ts';
import { START } from './components/start-pages.tsx';
import { pageResults, results } from './docs.test-support.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application);
});
afterAll(() => app?.close());

/** The scope radios of a document: their name and value, and whether each is checked. */
function radios(body: string) {
  return [...body.matchAll(/<input [^>]*type="radio"[^>]*>/g)].map(([tag]) => ({ name: /name="([^"]*)"/.exec(tag)?.[1], value: /value="([^"]*)"/.exec(tag)?.[1], checked: /\schecked(?:=|\s|\/|>)/.test(tag) }));
}

// Some tests boot apps of their own (server-rendered, throttled): slow on a busy machine.
describe('the search (a server route)', () => {
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
    // Without JavaScript the scopes are radios of the GET form, and no ARIA widget is promised before the page hydrates.
    expect(body).toMatch(/<form class="search-form" role="search" action="\/docs\/search" method="get"/);
    expect(radios(body).map((radio) => radio.value)).toEqual(['all', 'pages', 'sections']);
    expect(radios(body).every((radio) => radio.name === 'scope')).toBe(true);
    expect(body).not.toMatch(/role="(?:combobox|listbox|option)"/);
    // The note names the shortcut the layouts listen for: the chord, not a single key.
    expect(body).toContain('Press <kbd>⌘K</kbd> or <kbd>Ctrl K</kbd> on any docs page to search.');
  });

  it('keeps the layer and the page answer of one URL apart in a shared cache: different ETags, Vary names the region', async () => {
    const layer = await app.layering().get('/docs/search?q=onOneServer').assertOk();
    const visit = await app.navigating().get('/docs/search?q=onOneServer').assertOk();
    expect(layer.headers.get('etag')).toMatch(/^"[\w-]{27}"$/);
    expect(layer.headers.get('etag')).not.toBe(visit.headers.get('etag'));
    for (const response of [layer, visit]) {
      expect(response.headers.get('vary')!.toLowerCase().split(/\s*,\s*/)).toContain('x-marmeon-region');
    }
  });

  it('renders the pages and then the sections with their page and navigation section, and Where to start without a query', async () => {
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
    const document = { headers: { accept: 'text/html' } };
    const found = (await ssr.get('/docs/search?q=onOneServer', document).assertOk()).body;
    expect(found).toContain('On a page');
    expect(found).toMatch(/<a [^>]*href="\/docs\/scheduling#[^"]*"[^>]*>[\s\S]*?Task Scheduling › Digging Deeper/);
    expect(found).toContain('<button type="submit"');
    const titles = await ssr.get('/docs/search?q=routing', document).assertOk();
    expect(titles.body).toMatch(/search-group-title[^>]*>Pages</);
    const empty = (await ssr.get('/docs/search', document).assertOk()).body;
    const start = empty.slice(empty.indexOf('Where to start'), empty.indexOf('</section>', empty.indexOf('Where to start')));
    expect([...start.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1])).toEqual(START.map((page) => page.path));
    expect(empty).toContain('Where to start');
    expect(empty).not.toContain('On a page');
    expect(empty).toContain('role="status"');
    expect(empty).toContain('Type to search');
  });

  it('without JavaScript, ?scope=pages is the page with only the pages group and the Pages radio checked', async () => {
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
    const body = (await ssr.get('/docs/search?q=routing&scope=pages', { headers: { accept: 'text/html' } }).assertOk()).body;
    expect(radios(body).filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(['pages']);
    expect(body).toMatch(/search-group-title[^>]*>Pages</);
    expect(body).not.toContain('On a page');
  });

  it('scope pages answers pages only, scope sections sections only, everything both — and an unknown scope is everything', async () => {
    const pages = await app.navigating().get('/docs/search?q=routing&scope=pages').assertOk();
    expect(results(pages)).toEqual([]);
    expect(pageResults(pages).map((hit) => hit.href)).toContain('/docs/routing');
    // The answer says what it is for, so the view can tell it from the list of an earlier query.
    expect(pages.page()!.props).toMatchObject({ results: { q: 'routing', scope: 'pages' } });
    const sections = await app.navigating().get('/docs/search?q=routing&scope=sections').assertOk();
    expect(pageResults(sections)).toEqual([]);
    expect(results(sections).length).toBeGreaterThan(0);
    const all = await app.navigating().get('/docs/search?q=routing').assertOk();
    expect(pageResults(all).length).toBeGreaterThan(0);
    expect(results(all).length).toBeGreaterThan(0);
    const unknown = await app.navigating().get('/docs/search?q=routing&scope=%3Cscript%3E').assertOk();
    expect(pageResults(unknown)).toEqual(pageResults(all));
    expect(results(unknown)).toEqual(results(all));
    expect(unknown.page()!.query).toEqual({ q: 'routing' });
    expect(unknown.page()!.queryDefaults).toEqual({ q: '', scope: 'all' });
  });

  it('a query over 100 characters is invalid and falls back to the empty search (no 422, no 500, no work)', async () => {
    const response = await app.navigating().get(`/docs/search?q=${'onOneServer'.repeat(910)}`).assertOk();
    expect(results(response)).toEqual([]);
    // The invalid value is dropped: the page's query is empty, its default the empty search.
    expect(response.page()!.query).toEqual({});
    expect(response.page()!.queryDefaults).toEqual({ q: '', scope: 'all' });
  });

  it('is throttled per client (the route’s limiter, DOCS_SEARCH_PER_MINUTE)', async () => {
    const limited = await createTestApp(application, { env: { DOCS_SEARCH_PER_MINUTE: '2' } });
    await limited.get('/docs/search?q=a').assertOk();
    await limited.get('/docs/search?q=b').assertOk();
    await limited.get('/docs/search?q=c').assertStatus(429);
  });
});
