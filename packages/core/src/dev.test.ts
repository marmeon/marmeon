import { describe, expect, it } from 'vitest';
import { devHosts, devOnly, devSecured, hostAllowed, LOOPBACK_HOSTS } from './dev.ts';

const request = (host: string | undefined, url = 'http://localhost/_marmeon/mail') => new Request(url, host === undefined ? {} : { headers: { host } });

describe('the guard of every development route (E200)', () => {
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
});
