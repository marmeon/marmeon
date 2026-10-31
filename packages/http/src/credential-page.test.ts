import type { HttpContext } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { credentialPage } from './credential-page.ts';

const ctx = {} as HttpContext;
const at = (search: string) => ({ request: new Request(`http://app.test/events/launch${search}`) }) as HttpContext;
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

  describe('with `query`', () => {
    const cached = () => new Response('x', { headers: { 'cache-control': 'public, max-age=60' } });
    const invite = credentialPage({ query: ['invite'] });
    const handle = (search: string, make: () => Response = cached) => new invite().handle(at(search), async () => make());

    it('leaves an answer without the parameter as the route made it', async () => {
      for (const search of ['', '?page=2', '?invites=1', '?Invite=x', '?other=invite']) {
        const response = await handle(search);
        expect([search, response.headers.get('cache-control'), response.headers.has('x-robots-tag'), response.headers.has('referrer-policy')]).toEqual([search, 'public, max-age=60', false, false]);
      }
    });

    it.each(['?invite=x', '?invite=', '?invite', '?a=1&invite=x', '?invite=x&invite=y'])('sends the three headers on %s', async (search) => {
      const response = await handle(search);
      expect(response.headers.get('cache-control')).toBe('no-store, private');
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it.each([
      ['a redirect', () => Response.redirect('http://app.test/home', 303)],
      ['a binder 404', () => new Response('missing', { status: 404 })],
      ['a throttle 429', () => new Response('slow', { status: 429, headers: { 'retry-after': '30' } })],
    ])('sends them on %s when the parameter is present, and not when it is absent', async (_name, make) => {
      expect((await handle('?invite=x', make)).headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect((await handle('', make)).headers.has('x-robots-tag')).toBe(false);
    });

    it('takes any of several names', async () => {
      const any = credentialPage({ query: ['invite', 'registered'] });
      const run = async (search: string) => new any().handle(at(search), async () => cached());
      expect((await run('?registered=1')).headers.get('cache-control')).toBe('no-store, private');
      expect((await run('?x=1')).headers.get('cache-control')).toBe('public, max-age=60');
    });

    it('refuses a list that names nothing', () => {
      // @ts-expect-error an empty list names nothing
      expect(() => credentialPage({ query: [] })).toThrow(TypeError);
      expect(() => credentialPage({ query: [''] })).toThrow(TypeError);
      // @ts-expect-error a name alone is no list
      expect(() => credentialPage({ query: 'invite' })).toThrow(TypeError);
    });

    describe('two instances on one route', () => {
      const guest = credentialPage({ query: ['g'] });
      const sameOrigin = credentialPage({ query: ['invite'], referrer: 'same-origin' });
      const stacked = async (outer: ReturnType<typeof credentialPage>, inner: ReturnType<typeof credentialPage>, search: string, make: () => Response = () => new Response('x')) =>
        new outer().handle(at(search), async () => new inner().handle(at(search), async () => make()));

      it.each([
        ['same-origin inside', guest, sameOrigin],
        ['same-origin outside', sameOrigin, guest],
      ])('lets no-referrer win when both parameters are present (%s)', async (_name, outer, inner) => {
        expect((await stacked(outer, inner, '?g=1&invite=2')).headers.get('referrer-policy')).toBe('no-referrer');
      });

      it.each([
        ['same-origin inside', guest, sameOrigin],
        ['same-origin outside', sameOrigin, guest],
      ])('keeps each one alone (%s)', async (_name, outer, inner) => {
        expect((await stacked(outer, inner, '?invite=2')).headers.get('referrer-policy')).toBe('same-origin');
        expect((await stacked(outer, inner, '?g=1')).headers.get('referrer-policy')).toBe('no-referrer');
        expect((await stacked(outer, inner, '')).headers.has('referrer-policy')).toBe(false);
      });

      it('keeps a same-origin of the controller under a no-referrer instance', async () => {
        const response = await stacked(guest, credentialPage({ query: ['g'] }), '?g=1', () => new Response('x', { headers: { 'referrer-policy': 'same-origin' } }));
        expect(response.headers.get('referrer-policy')).toBe('same-origin');
      });
    });
  });
});
