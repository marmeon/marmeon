import { describe, expect, it } from 'vitest';
import { defineRoutes, everyone, Router } from './index.ts';
import { restParam } from './rest-path.ts';

const value = (text: string) => ({ kind: 'value', value: text });
const refused = { kind: 'refused' };

describe('restParam at the root', () => {
  it.each([
    ['/', ''],
    ['/a/b', 'a/b'],
    ['/caf%C3%A9', 'café'],
    ['/a+b', 'a+b'],
    ['/a%20b/c', 'a b/c'],
  ])('reads %s as %j', (pathname, expected) => {
    expect(restParam('/:path*', pathname, 'GET')).toEqual(value(expected));
  });

  it.each(['//evil.com/x', '/a//b', '/a%2Fb', '/a%2fb', '/a%5Cb', '/a%00b', '/a%0D%0Ab', '/a%7Fb', '/%ZZ', '/a/../b', '/a/%2e%2E/b', '/a/./b', '//'])(
    'refuses %s',
    (pathname) => {
      expect(restParam('/:path*', pathname, 'GET')).toEqual(refused);
    },
  );
});

describe('restParam after a prefix', () => {
  const read = (pathname: string, method = 'GET', search = '') => restParam('/docs/:page*', pathname, method, search);

  it('takes nothing, one segment or many', () => {
    expect(read('/docs')).toEqual(value(''));
    expect(read('/docs/a')).toEqual(value('a'));
    expect(read('/docs/a/b')).toEqual(value('a/b'));
  });

  it('sends a trailing slash to the path without it, for GET and HEAD, keeping the query', () => {
    expect(read('/docs/')).toEqual({ kind: 'redirect', location: '/docs' });
    expect(read('/docs/a/', 'GET', '?q=1')).toEqual({ kind: 'redirect', location: '/docs/a?q=1' });
    expect(read('/docs/a/', 'HEAD')).toEqual({ kind: 'redirect', location: '/docs/a' });
  });

  it('refuses a trailing slash for any other method, and a doubled one', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect(read('/docs/a/', method)).toEqual(refused);
    expect(read('/docs//a')).toEqual(refused);
    expect(read('/docs/a//')).toEqual(refused);
    expect(read('/docs//')).toEqual(refused);
  });

  it('refuses a trailing slash after a bad segment instead of sending it on', () => {
    expect(read('/docs/a%2Fb/')).toEqual(refused);
    expect(read('/docs/%ZZ/')).toEqual(refused);
  });

  it('refuses the segments the pattern itself spends when they hold a / or cannot be decoded', () => {
    expect(restParam('/:locale/:path*', '/de/a', 'GET', '', { locale: 'de' })).toEqual(value('a'));
    expect(restParam('/:locale/:path*', '/de', 'GET', '', { locale: 'de' })).toEqual(value(''));
    expect(restParam('/:locale/:path*', '/d%2Fe/a', 'GET', '', { locale: 'd/e' })).toEqual(refused);
    expect(restParam('/:locale/:path*', '/%ZZ/a', 'GET')).toEqual(refused);
    expect(restParam('/:locale/:path*', '//a', 'GET')).toEqual(refused);
    expect(restParam('/:locale/:path*', '/', 'GET')).toEqual(refused);
  });
});

describe('a parameter before the rest that spans a /', () => {
  const router = new Router().load(defineRoutes((Route) => void Route.authorize(everyone).get('/plus/:a{.+}/:path*', (ctx: { params: { a: string; path: string } }) => `${ctx.params.a}|${ctx.params.path}`)));
  const route = router.routes[0]!;
  const run = (url: string, params: Record<string, string>) => router.dispatch(route, { request: new Request(`http://localhost${url}`), params });

  it('answers 404 when the server gave it more than one segment, since the rest would overlap it', async () => {
    await expect(run('/plus/x/y/z', { a: 'x/y/z' })).rejects.toMatchObject({ status: 404 });
  });

  it('answers when each parameter holds the segment the count gives it', async () => {
    expect(await (await run('/plus/x/y/z', { a: 'x' })).text()).toBe('x|y/z');
  });
});

describe('Router.dispatch with a rest route', () => {
  const router = new Router().load(defineRoutes((Route) => void Route.authorize(everyone).get('/files/:path*', (ctx: { params: { path: string } }) => `path=${ctx.params.path}`)));
  const route = router.routes[0]!;
  const run = (url: string, params: Record<string, string> = {}, method = 'GET') => router.dispatch(route, { request: new Request(`http://localhost${url}`, { method }), params });

  it('gives the controller the value it works out itself, over what the caller passes in', async () => {
    expect(await (await run('/files/a/b', { path: '/evil.com' })).text()).toBe('path=a/b');
    expect(await (await run('/files', { path: '/evil.com' })).text()).toBe('path=');
    expect(await (await run('/files/caf%C3%A9', { path: 'x' })).text()).toBe('path=café');
  });

  it('answers 404 for a path the rule refuses, whatever the caller passes in', async () => {
    for (const url of ['/files//x', '/files/a%2Fb', '/files/a%5Cb', '/files/a%00b', '/files/%ZZ', '/files/a//b']) {
      await expect(run(url, { path: 'fine' }), url).rejects.toMatchObject({ status: 404 });
    }
  });

  it('sends a trailing slash on GET with 301, and refuses it on POST', async () => {
    const response = await run('/files/a/?x=1');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/files/a?x=1');
    await expect(run('/files/a/', {}, 'POST')).rejects.toMatchObject({ status: 404 });
  });
});

describe('the variant without a locale of a localized rest route', () => {
  const router = new Router().load(defineRoutes((Route) => void Route.localized().authorize(everyone).get('/:path*', () => 'page')));
  const variant = router.registrationOrder.find((route) => route.generatedFrom)!;
  const urlLocales = { supported: ['de', 'en'], preferred: async () => 'de' } as never;
  const run = (url: string) => router.dispatch(variant, { request: new Request(`http://app.test${url}`), params: {} }, { urlLocales });

  it('sends to the preferred locale with the path encoded segment by segment', async () => {
    for (const [url, location] of [['/', '/de'], ['/leistungen', '/de/leistungen'], ['/a%20b/c%3Fd?x=1', '/de/a%20b/c%3Fd?x=1']] as const) {
      const response = await run(url);
      expect([url, response.status, response.headers.get('location')]).toEqual([url, 302, location]);
    }
  });

  it('answers 404 for a path that is none, and 301 for a trailing slash, before any language is chosen', async () => {
    for (const url of ['//evil.com/x', '/a%2Fb', '/a//b', '/%ZZ']) await expect(run(url), url).rejects.toMatchObject({ status: 404 });
    const slash = await run('/leistungen/');
    expect([slash.status, slash.headers.get('location')]).toEqual([301, '/leistungen']);
  });
});
