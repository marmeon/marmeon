import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import application from '../../bootstrap/app.ts';

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application);
});
afterAll(() => app?.close());
afterEach(() => vi.useRealTimers());

describe('the render-clock island', () => {
  it('answers its region object, public for five seconds, with an ETag, a vary and no cookie', async () => {
    const response = await app.island('site.render-clock').assertOk().assertIsland('site/islands/RenderClock');
    expect(response.island()?.props).toEqual({ renderedAt: expect.any(String) });
    expect(response.headers.get('cache-control')).toBe('public, max-age=5');
    expect(response.headers.get('etag')).toMatch(/^"[\w-]{27}"$/);
    expect(response.headers.get('vary')?.toLowerCase()).toContain('x-marmeon-region');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('gets a new ETag once the body changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const first = await app.island('site.render-clock').assertOk();
    const same = await app.island('site.render-clock').assertOk();
    expect(same.headers.get('etag')).toBe(first.headers.get('etag'));
    vi.setSystemTime(new Date('2030-01-01T00:00:06Z'));
    const later = await app.island('site.render-clock').assertOk();
    expect(later.headers.get('etag')).not.toBe(first.headers.get('etag'));
  });

  it('is a 404 when visited directly, and not cached publicly', async () => {
    for (const response of [await app.get('/islands/render-clock'), await app.get('/islands/render-clock', { headers: { accept: 'text/html' } })]) {
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control') ?? '').not.toContain('public');
    }
  });

  it('leaves the pages at the long time', async () => {
    expect((await app.get('/').assertOk()).headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('is not kept at all with SITE_CACHE_MAX_AGE=0', async () => {
    const off = await createTestApp(application, { env: { SITE_CACHE_MAX_AGE: '0' } });
    onTestFinished(() => off.close());
    expect((await off.island('site.render-clock').assertOk()).headers.get('cache-control')).toBe('public, max-age=0');
  });

  it('is no-cache in development', async () => {
    const dev = await createTestApp(application, { env: { NODE_ENV: 'development' } });
    onTestFinished(() => dev.close());
    expect((await dev.island('site.render-clock').assertOk()).headers.get('cache-control')).toBe('no-cache');
  });

  it('does not shorten the cache of a page that merely asks for an island, and never publishes a cookie', async () => {
    // The region header is the request's; only the kernel's island answer sets it on a response.
    const page = await app.get('/', { headers: { accept: 'text/html', 'x-marmeon-region': 'island' } });
    expect(page.headers.get('x-marmeon-region')).toBeNull();
    expect(page.headers.get('set-cookie')).toBeNull();
    expect(page.headers.get('cache-control') ?? '').not.toBe('public, max-age=5');
  });
});
