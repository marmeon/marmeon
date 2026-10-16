import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SiteConfig } from '../../config/site.ts';
import { CachePublicly } from '../site/middleware/CachePublicly.ts';
import { repo } from './docs.test-support.ts';
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
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
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
