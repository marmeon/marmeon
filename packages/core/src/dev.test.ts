import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devHosts, devOnly, devSecured, fromRemotePeer, hostAllowed, LOOPBACK_HOSTS, markRemotePeer } from './dev.ts';

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

  describe('a request from another machine', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const marked = () => {
      const req = request('localhost');
      markRemotePeer(req);
      return req;
    };

    it('gets 403 with the peer text and the dev headers; the handler never runs; the same request unmarked gets 200', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      let ran = 0;
      const handler = devOnly(devHosts(undefined), () => {
        ran++;
        return new Response('mail');
      });
      const refused = await handler({ request: marked() });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe('Development routes answer only connections from this machine. Open this page on the machine that runs the server.\n');
      expect(ran).toBe(0);
      expect(refused.headers.get('cache-control')).toBe('no-store');
      expect([...refused.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([]);

      expect((await handler({ request: request('localhost') })).status).toBe(200);
      expect(ran).toBe(1);
    });

    it('under NODE_ENV=production is a 404 — the environment is asked first', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const handler = devOnly(devHosts(undefined), () => new Response('mail'));
      expect((await handler({ request: marked() })).status).toBe(404);
    });

    it('is refused for its peer before its host is looked at', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const req = request('evil.example');
      markRemotePeer(req);
      const refused = await devOnly(devHosts(undefined), () => new Response('mail'))({ request: req });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toMatch(/^Development routes answer only connections from this machine/);
    });

    it('is refused by a second copy of the module too', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const specifier = './dev.ts?copy'; // a query makes a second instance of the module
      const copy = (await import(specifier)) as typeof import('./dev.ts');
      expect(copy.markRemotePeer).not.toBe(markRemotePeer);
      const req = request('localhost');
      copy.markRemotePeer(req);
      expect(fromRemotePeer(req)).toBe(true);
      expect((await devOnly(devHosts(undefined), () => new Response('mail'))({ request: req })).status).toBe(403);
      const other = request('localhost');
      markRemotePeer(other);
      expect(copy.fromRemotePeer(other)).toBe(true);
    });

    it('stops the import when something that is no WeakSet already sits on the shared key', () => {
      // The key cannot be unset in this process once the module defined it, so a fresh process plants the fake.
      const dev = fileURLToPath(new URL('./dev.ts', import.meta.url));
      const script = `globalThis[Symbol.for('marmeon.dev.remotePeers')] = { has: () => false, add() {} };
        try { await import(${JSON.stringify(dev)}); console.log('imported'); } catch (e) { console.log('threw: ' + e.message); }`;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      expect(out).toMatch(/^threw: .*is not a WeakSet/);
    });

    it('is not marked in a copy', () => {
      const req = marked();
      expect(fromRemotePeer(req)).toBe(true);
      expect(fromRemotePeer(new Request(req.url, req))).toBe(false);
    });

    it('as a middleware never reaches `next`', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      let reached = 0;
      const guard = devOnly(devHosts(undefined), (_ctx: { request: Request }, next: () => Promise<Response>) => next());
      const response = await guard({ request: marked() }, () => {
        reached++;
        return Promise.resolve(new Response('page'));
      });
      expect(response.status).toBe(403);
      expect(reached).toBe(0);
    });
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
