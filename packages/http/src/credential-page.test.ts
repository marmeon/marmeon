import type { HttpContext } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { credentialPage } from './credential-page.ts';

const ctx = {} as HttpContext;
const run = async (response: Response) => new (credentialPage())().handle(ctx, async () => response);

describe('credentialPage()', () => {
  it.each([
    ['a page', () => new Response('x')],
    ['a redirect', () => Response.redirect('http://app.test/home', 303)],
    ['an error page', () => new Response('missing', { status: 404 })],
    ['a validation failure', () => new Response(null, { status: 422 })],
  ])('sends the three headers on %s', async (_name, make) => {
    const response = await run(make());
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('keeps the status and the location of what it wraps', async () => {
    const response = await run(Response.redirect('http://app.test/home', 303));
    expect([response.status, response.headers.get('location')]).toEqual([303, 'http://app.test/home']);
  });

  it('replaces a Cache-Control that lets a cache keep the page', async () => {
    const response = await run(new Response('x', { headers: { 'cache-control': 'public, max-age=300' } }));
    expect(response.headers.get('cache-control')).toBe('no-store, private');
  });

  it('keeps a policy set on purpose (no-referrer, same-origin) and replaces a weaker one, reading the last token', async () => {
    for (const kept of ['no-referrer', 'same-origin', 'origin, same-origin', 'Same-Origin']) {
      expect((await run(new Response('x', { headers: { 'referrer-policy': kept } }))).headers.get('referrer-policy')).toBe(kept);
    }
    for (const weaker of ['unsafe-url', 'origin', 'strict-origin-when-cross-origin', 'same-origin, unsafe-url', 'bogus']) {
      expect((await run(new Response('x', { headers: { 'referrer-policy': weaker } }))).headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('sets same-origin on request, and leaves a no-referrer of the response alone', async () => {
    const run = (response: Response) => new (credentialPage({ referrer: 'same-origin' }))().handle(ctx, async () => response);
    expect((await run(new Response('x'))).headers.get('referrer-policy')).toBe('same-origin');
    expect((await run(new Response('x', { headers: { 'referrer-policy': 'no-referrer' } }))).headers.get('referrer-policy')).toBe('no-referrer');
    expect((await run(new Response('x', { headers: { 'referrer-policy': 'unsafe-url' } }))).headers.get('referrer-policy')).toBe('same-origin');
  });

  it('serves the pattern for a form behind a token: the token route redirects to a page without it, which may keep same-origin', async () => {
    // The token route: no Referer leaves it, and the redirect carries none of the token.
    const exchange = await run(Response.redirect('http://app.test/invitation', 303));
    expect([exchange.status, exchange.headers.get('location'), exchange.headers.get('referrer-policy')]).toEqual([303, 'http://app.test/invitation', 'no-referrer']);
    // The page after it is not behind credentialPage(): its own same-origin stays for back().
    expect(new Response('x', { headers: { 'referrer-policy': 'same-origin' } }).headers.get('referrer-policy')).toBe('same-origin');
  });

  it('does not touch a response a controller hands out twice', async () => {
    const shared = new Response('x');
    await run(shared);
    expect(shared.headers.has('cache-control')).toBe(false);
  });
});
