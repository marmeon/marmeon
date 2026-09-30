import { describe, expect, it } from 'vitest';
import { CookieJar, parseCookies, serializeCookie, withQueuedCookies } from './cookies.ts';
import { defineRoutes, Router } from './router.ts';

describe('cookies', () => {
  it('parses the Cookie header — decoded, quoted values unwrapped, first occurrence wins', () => {
    const cookies = parseCookies('a=1; b=hello%20world; c="quoted"; a=2; broken; =x; bad=%E0%A4%A');
    expect(Object.fromEntries(cookies)).toEqual({ a: '1', b: 'hello world', c: 'quoted', bad: '%E0%A4%A' });
  });

  it('serializes with safe defaults (HttpOnly, SameSite=Lax, Path=/)', () => {
    expect(serializeCookie('session', 'a b;c')).toBe('session=a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax');
    expect(serializeCookie('x', '1', { maxAge: 60, secure: true, httpOnly: false, sameSite: 'strict', domain: 'app.test' })).toBe(
      'x=1; Path=/; Domain=app.test; Max-Age=60; Secure; SameSite=Strict',
    );
  });

  it('refuses invalid names and SameSite=None without Secure', () => {
    expect(() => serializeCookie('bad name', '1')).toThrow('Invalid cookie name "bad name".');
    expect(() => serializeCookie('x', '1', { sameSite: 'none' })).toThrow('SameSite=None requires secure: true');
  });

  it('reads incoming cookies and queues outgoing ones', () => {
    const jar = new CookieJar('theme=dark');
    jar.set('theme', 'light');
    jar.set('theme', 'blue'); // the last set wins
    jar.delete('old');

    expect(jar.get('theme')).toBe('dark'); // what the client sent
    expect(jar.has('missing')).toBe(false);
    expect(jar.queued()).toEqual([
      'theme=blue; Path=/; HttpOnly; SameSite=Lax',
      'old=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
    ]);
  });

  it('adds queued cookies even to responses with immutable headers', () => {
    const jar = new CookieJar(null);
    jar.set('a', '1');
    const response = withQueuedCookies(Response.redirect('http://app.test/next', 302), jar);
    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/; HttpOnly; SameSite=Lax']);
  });

  it('are part of every context the router dispatches', async () => {
    const router = new Router().load(
      defineRoutes((Route) => {
        Route.post('/prefs', async (ctx) => {
          const { theme } = await ctx.input();
          ctx.cookies.set('theme', String(theme));
          return { previous: ctx.cookies.get('theme') ?? null, page: ctx.query.get('page') };
        });
      }),
    );
    const request = new Request('http://app.test/prefs?page=3', {
      method: 'POST',
      body: new URLSearchParams({ theme: 'light' }),
      headers: { cookie: 'theme=dark' },
    });
    const response = await router.dispatch(router.routes[0]!, { request, params: {} });
    expect(await response.json()).toEqual({ previous: 'dark', page: '3' });
  });
});
