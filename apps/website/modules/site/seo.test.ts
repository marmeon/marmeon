import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import docsConfig from '../../docs.config.ts';
import { expectOriginFromAppUrl } from './origin.test-support.ts';
import { robotsTxt, sitemapPaths, sitemapXml } from './seo.ts';

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application);
});

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]!);

describe('/sitemap.xml', () => {
  it('lists the landing, the docs, every page in the navigation’s order, and the legal pages — nothing else', async () => {
    const response = await app.get('/sitemap.xml').assertOk();
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);
    expect(response.headers.get('etag')).not.toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    const expected = ['/', '/docs', ...docsConfig.sections.flatMap((section) => section.pages.map((entry) => `/docs/${entry.slug}`)), '/imprint', '/privacy'].map((path) => `http://localhost${path}`);
    expect(locs(response.body)).toEqual(expected);
    expect(response.body).not.toContain('.md<');
    expect(response.body).not.toContain('/docs/search');
  });

  it('names only URLs that answer', async () => {
    const urls = locs((await app.get('/sitemap.xml').assertOk()).body);
    for (const url of urls) await app.get(new URL(url).pathname, { headers: { accept: 'text/html' } }).assertOk();
  }, 60_000); // requests every URL of the sitemap

  it('leaves out a draft and escapes the URLs', () => {
    expect(sitemapPaths([{ path: '/docs/a', pending: false }, { path: '/docs/b', pending: true }])).toEqual(['/', '/docs', '/docs/a', '/imprint', '/privacy']);
    expect(sitemapXml(['http://x.test/?a=1&b=2'])).toContain('<loc>http://x.test/?a=1&amp;b=2</loc>');
  });

  it('takes its origin from APP_URL, not from the request', async () => {
    await expectOriginFromAppUrl('/sitemap.xml', (response) => locs(response.body)[0] ?? null, 'https://docs.example/');
  });
});

describe('/robots.txt', () => {
  it('allows everything but the search and names the sitemap', async () => {
    const response = await app.get('/robots.txt').assertOk();
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.body).toBe('User-agent: *\nDisallow: /docs/search$\nDisallow: /docs/search?\n\nSitemap: http://localhost/sitemap.xml\n');
    expect(response.body).toBe(robotsTxt('http://localhost/sitemap.xml'));
  });

  it('takes its origin from APP_URL, not from the request', async () => {
    await expectOriginFromAppUrl('/robots.txt', (response) => /^Sitemap: (.*)$/m.exec(response.body)?.[1] ?? null, 'https://docs.example/sitemap.xml');
  });

  it('answers no other method', async () => {
    const response = await app.post('/robots.txt');
    expect([404, 405]).toContain(response.status);
    expect(response.headers.get('cache-control') ?? '').not.toContain('public');
  });
});
