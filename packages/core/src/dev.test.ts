import { afterEach, describe, expect, it, vi } from 'vitest';
import { devHosts, devOnly, devSecured, hostAllowed, LOOPBACK_HOSTS } from './dev.ts';

const request = (host: string | undefined, url = 'http://localhost/_marmeon/mail') => new Request(url, host === undefined ? {} : { headers: { host } });

describe('the guard of every development route', () => {
  it('devHosts: the loopback names and the host of APP_URL — lower case, no port; a broken APP_URL adds nothing', () => {
    expect([...devHosts(undefined)]).toEqual(LOOPBACK_HOSTS);
    expect([...devHosts('https://Shop.Example:8443/base')]).toEqual([...LOOPBACK_HOSTS, 'shop.example']);
    expect([...devHosts('http://[::1]:3960')]).toEqual(LOOPBACK_HOSTS);
    expect([...devHosts('not a url')]).toEqual(LOOPBACK_HOSTS);
  });

  it('hostAllowed: only those names, any port — never a name that merely starts like one, userinfo, a smuggled path or an empty Host', () => {
    const hosts = devHosts('http://app.test:8080');
    for (const host of ['localhost', 'localhost:3960', '127.0.0.1:3960', '[::1]:3960', 'app.test', 'APP.test:8080']) {
      expect(hostAllowed(request(host), hosts), host).toBe(true);
    }
    for (const host of ['evil.example', 'evil.example:3960', 'localhost.evil.example', 'app.test.evil.example', '127.0.0.2', 'localhost@evil.example', 'localhost/x', 'localhost?x', '', `${'a'.repeat(250)}.localhost`]) {
      expect(hostAllowed(request(host), hosts), host).toBe(false);
    }
    // Without a Host header (an in-process request): the URL's host.
    expect(hostAllowed(request(undefined, 'http://evil.example/_marmeon/mail'), hosts)).toBe(false);
    expect(hostAllowed(request(undefined, 'http://localhost:3960/_marmeon/mail'), hosts)).toBe(true);
  });

  it('devOnly: another host gets 403 and the handler never runs; every answer leaves with the dev headers and without CORS', async () => {
    const hosts = devHosts('http://app.test');
    let ran = 0;
    const handler = devOnly(hosts, (ctx: { request: Request }) => {
      ran++;
      return new Response(`hello ${new URL(ctx.request.url).pathname}`, { headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain' } });
    });

    const refused = await handler({ request: request('evil.example') });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/^Development routes answer only on localhost, 127\.0\.0\.1, \[::1\] and the host of APP_URL/);
    expect(ran).toBe(0);

    const answered = await handler({ request: request('app.test') });
    expect(answered.status).toBe(200);
    expect(await answered.text()).toBe('hello /_marmeon/mail');
    expect(ran).toBe(1);
    for (const response of [refused, answered]) {
      expect(Object.fromEntries(['cache-control', 'x-content-type-options', 'cross-origin-resource-policy', 'cross-origin-opener-policy', 'content-security-policy'].map((name) => [name, response.headers.get(name)]))).toEqual({
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'cross-origin-opener-policy': 'same-origin',
        'content-security-policy': "frame-ancestors 'self'",
      });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('devOnly as a middleware: `next` comes through, and a page keeps its own CSP', async () => {
    const guard = devOnly(devHosts(undefined), (_ctx: { request: Request }, next: () => Promise<Response>) => next());
    const page = () => Promise.resolve(new Response('<p>page</p>', { headers: { 'content-security-policy': "default-src 'none'", 'cache-control': 'max-age=60' } }));
    const answered = await guard({ request: request('localhost') }, page);
    expect(answered.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(answered.headers.get('cache-control')).toBe('no-store');
    expect((await guard({ request: request('evil.example') }, page)).status).toBe(403);
    expect(devSecured(new Response('x', { status: 404 })).status).toBe(404);
  });

  describe('outside development: a 404, whatever the host (fail-closed) — APP_URL\'s host is public on a server', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each(['production', 'staging', 'prod', undefined])('NODE_ENV=%s: the handler never runs, even for APP_URL\'s host', async (name) => {
      vi.stubEnv('NODE_ENV', name);
      let ran = 0;
      const handler = devOnly(devHosts('https://shop.example'), () => {
        ran++;
        return new Response('report');
      });
      for (const host of ['shop.example', 'localhost']) {
        const response = await handler({ request: request(host, 'https://shop.example/_dev/report') });
        expect(response.status, `${host} under NODE_ENV=${name}`).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
      expect(ran, 'a development route ran outside development').toBe(0);
    });

    it('development and test: the host decides', async () => {
      for (const name of ['development', 'test']) {
        vi.stubEnv('NODE_ENV', name);
        const handler = devOnly(devHosts('https://shop.example'), () => new Response('report'));
        expect((await handler({ request: request('shop.example') })).status, name).toBe(200);
        expect((await handler({ request: request('evil.example') })).status, name).toBe(403);
      }
    });
  });
});
