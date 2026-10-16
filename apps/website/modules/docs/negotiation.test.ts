import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { expectOriginFromAppUrl } from '../site/origin.test-support.ts';
import { SSR_TEST_TIMEOUT } from './test-timeouts.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
}, 30_000);
afterAll(() => server?.close());

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const MARKDOWN = 'text/markdown';

let app: TestApp;
let ssr: TestApp;
beforeAll(async () => {
  app = await createTestApp(application);
  ssr = await createTestApp(application, { ssr: true, ssrServer: server });
}, SSR_TEST_TIMEOUT);
afterAll(async () => {
  await app?.close();
  await ssr?.close();
});

const vary = (response: { headers: Headers }) => (response.headers.get('vary') ?? '').toLowerCase().split(/\s*,\s*/);

describe('/docs/<slug> by Accept', () => {
  it('answers Markdown to a client that asks for it: the body of the .md page, cacheable, in Vary', async () => {
    const response = await app.get('/docs/routing', { headers: { accept: MARKDOWN } }).assertOk();
    const source = await app.get('/docs/routing.md').assertOk();
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.body).toBe(source.body);
    expect(response.headers.get('content-location')).toBe('/docs/routing.md');
    expect(response.headers.get('link')).toBe('<http://localhost/docs/routing>; rel="canonical"');
    expect(vary(response)).toEqual(expect.arrayContaining(['accept', 'x-marmeon']));
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('answers HTML to a browser, also says Vary: Accept, and has its own ETag', async () => {
    const html = await ssr.get('/docs/routing', { headers: { accept: BROWSER } }).assertOk().assertServerRendered();
    const markdown = await ssr.get('/docs/routing', { headers: { accept: MARKDOWN } }).assertOk();
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(vary(html)).toContain('accept');
    expect(html.headers.get('etag')).not.toBe(markdown.headers.get('etag'));
  }, SSR_TEST_TIMEOUT);

  it('never answers 304 with the other variant: an ETag belongs to one of them', async () => {
    const markdown = await app.get('/docs/routing', { headers: { accept: MARKDOWN } }).assertOk();
    const etag = markdown.headers.get('etag')!;
    const browser = await ssr.get('/docs/routing', { headers: { accept: BROWSER, 'if-none-match': etag } });
    expect(browser.status).toBe(200);
    expect(browser.headers.get('content-type')).toContain('text/html');
    const notModified = await app.get('/docs/routing', { headers: { accept: MARKDOWN, 'if-none-match': etag } });
    expect(notModified.status).toBe(304);
    expect(vary(notModified)).toContain('accept');
    const htmlEtag = browser.headers.get('etag')!;
    const other = await app.get('/docs/routing', { headers: { accept: MARKDOWN, 'if-none-match': htmlEtag } });
    expect(other.status).toBe(200);
    expect(other.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  }, SSR_TEST_TIMEOUT);

  it('gives a Visit the page object even when it accepts Markdown', async () => {
    await app.navigating().get('/docs/routing', { headers: { accept: 'text/markdown, application/json' } }).assertOk().assertPage('docs/Page');
  });

  it('keeps an unknown page a 404', async () => {
    await app.get('/docs/no-such-page', { headers: { accept: MARKDOWN } }).assertNotFound();
  });

  it('takes the canonical URL from APP_URL, not from the request', async () => {
    await expectOriginFromAppUrl('/docs/routing', (response) => response.headers.get('link'), '<https://docs.example/docs/routing>; rel="canonical"', { accept: MARKDOWN });
  });
});

describe('/docs by Accept', () => {
  it('answers the index of /llms.txt as Markdown, linked to the .md pages', async () => {
    const response = await app.get('/docs', { headers: { accept: MARKDOWN } }).assertOk();
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.body.startsWith('# Marmeon')).toBe(true);
    expect(response.body).toContain('http://localhost/docs/routing.md');
    expect(response.body).toBe((await app.get('/llms.txt').assertOk()).body);
    expect(response.headers.get('link')).toBe('<http://localhost/docs>; rel="canonical"');
    expect(response.headers.get('content-location')).toBeNull();
    expect(vary(response)).toContain('accept');
  });

  it('answers HTML to a browser, with Vary: Accept and a pointer to /llms.txt', async () => {
    const html = await ssr.get('/docs', { headers: { accept: BROWSER } }).assertOk().assertServerRendered();
    expect(html.body).toContain('<link rel="alternate" type="text/markdown" href="/llms.txt"');
    expect(vary(html)).toContain('accept');
  }, SSR_TEST_TIMEOUT);

  it('takes the URLs from APP_URL, not from the request', async () => {
    await expectOriginFromAppUrl('/docs', (response) => (response.body.includes('https://docs.example/docs/routing.md') ? 'https://docs.example/docs/routing.md' : null), 'https://docs.example/docs/routing.md', { accept: MARKDOWN });
  });
});

describe('pages that are not negotiated', () => {
  it.each(['/', '/imprint', '/docs/search'])('%s stays HTML and has no Vary: Accept', async (path) => {
    const response = await ssr.get(path, { headers: { accept: MARKDOWN } }).assertOk();
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(vary(response)).not.toContain('accept');
  }, SSR_TEST_TIMEOUT);
});
