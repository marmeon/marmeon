import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { createHttpKernel } from '@marmeon/server';
import { describe, expect, it } from 'vitest';
import { CacheServiceProvider } from './index.ts';
import { clientKey, Limit, RateLimiter, throttle } from './rate-limiter.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

class LoginLimits {
  boot(app: { container: { make(key: typeof RateLimiter): RateLimiter } }) {
    app.container
      .make(RateLimiter)
      .for('login', async (ctx) => Limit.perMinute(3).by(`${String((await ctx.input()).email)}|${ctx.ip ?? ''}`))
      .for('client', (ctx) => Limit.perMinute(3).by(clientKey(ctx.ip)))
      .for('api', () => [Limit.perSecond(2), Limit.perMinute(100)]);
  }
}

class OwnVerify {
  static verify(): void {
    throw new Error('the start check called an app\'s own static verify');
  }
  handle(_ctx: unknown, next: () => Promise<Response>) {
    return next();
  }
}

async function boot({ broken = false } = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, CacheServiceProvider, LoginLimits],
    modules: [
      defineModule({
        name: 'limits',
        apiRoutes: openRoutes((Route) => {
          Route.middleware(throttle('login')).post('/login', () => ({ ok: true }));
          Route.middleware(throttle('client')).post('/client', () => ({ ok: true }));
          Route.middleware(throttle('api')).get('/items', () => []);
          if (broken) Route.middleware(throttle('nope')).get('/broken', () => []);
          // An app's middleware with a `static verify` of its own: the server's start check never calls it.
          Route.middleware(OwnVerify).get('/own', () => []);
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey(), CACHE_DRIVER: 'memory' } });
  return createHttpKernel(application);
}

const login = (email: string, accept = 'application/json') => ({
  method: 'POST',
  body: JSON.stringify({ email }),
  headers: { 'content-type': 'application/json', accept },
});

const peer = (remoteAddress: string, headers: Record<string, string> = {}) => ({
  init: { method: 'POST', headers: { accept: 'application/json', ...headers } },
  env: { remoteAddress },
});

describe('clientKey()', () => {
  it('keeps an IPv4 address and names a missing or empty one unknown', () => {
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
  });

  it('keeps an unreadable address as a key of its own instead of pooling clients', () => {
    expect(clientKey('not an address')).toBe('raw:not an address');
    expect(clientKey('not an address')).not.toBe(clientKey('another one'));
  });

  it('drops the port and the brackets a proxy may add', () => {
    expect(clientKey('203.0.113.9:54321')).toBe('203.0.113.9');
    expect(clientKey('[2001:db8:1:2::1]')).toBe('2001:db8:1:2::/64');
    expect(clientKey('[2001:db8:1:2::1]:443')).toBe('2001:db8:1:2::/64');
    expect(clientKey('[fe80::1%eth0]:443')).toBe('fe80:0:0:0::/64');
  });

  it('keys a NAT64 address like the IPv4 address it carries', () => {
    expect(clientKey('64:ff9b::203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('64:ff9b::cb00:7109')).toBe('203.0.113.9');
    expect(clientKey('64:ff9b:1::cb00:7109')).not.toBe('203.0.113.9');
  });

  it('keys an IPv6 address by its /64, however it is written', () => {
    const key = '2001:db8:1:2::/64';
    expect(clientKey('2001:db8:1:2::1')).toBe(key);
    expect(clientKey('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe(key);
    expect(clientKey('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe(key);
    expect(clientKey('2001:db8:1:2:3:4:5:6')).toBe(key);
    expect(clientKey('2001:db8:1:2::1%eth0')).toBe(key); // a zone id is not part of the client
    expect(clientKey('2001:db8:1:3::1')).not.toBe(key);
    expect(clientKey('2001:db8:2:2::1')).not.toBe(key);
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('::')).toBe('0:0:0:0::/64');
  });

  it('keys an IPv4-mapped address like the IPv4 address', () => {
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::FFFF:cb00:7109')).toBe('203.0.113.9');
    expect(clientKey('0:0:0:0:0:ffff:203.0.113.9')).toBe('203.0.113.9');
  });
});

describe('throttle() by the client', () => {
  it('counts a whole IPv6 /64 as one client — rotating the address inside it opens no new budget', async () => {
    const app = await boot();
    const statuses: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const { init, env } = peer(`2001:db8:1:2::${i.toString(16)}`);
      statuses.push((await app.request('/api/client', init, env)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    // Another /64 and an IPv4 address have budgets of their own.
    const other = peer('2001:db8:1:3::1');
    expect((await app.request('/api/client', other.init, other.env)).status).toBe(200);
    const v4 = peer('203.0.113.9');
    expect((await app.request('/api/client', v4.init, v4.env)).status).toBe(200);
  });

  it('counts an IPv4-mapped peer with its IPv4 address', async () => {
    const app = await boot();
    for (const remote of ['203.0.113.9', '::ffff:203.0.113.9', '203.0.113.9']) {
      const { init, env } = peer(remote);
      expect((await app.request('/api/client', init, env)).status).toBe(200);
    }
    const { init, env } = peer('::ffff:203.0.113.9');
    expect((await app.request('/api/client', init, env)).status).toBe(429);
  });

  it('is not escaped by X-Forwarded-For when no proxy is trusted', async () => {
    const app = await boot();
    const statuses: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const { init, env } = peer('203.0.113.9', { 'x-forwarded-for': `2001:db8:${i}::1` });
      statuses.push((await app.request('/api/client', init, env)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('throttle()', () => {
  it('lets the allowed attempts through, then answers 429 with Retry-After', async () => {
    const app = await boot();
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 4; i++) {
      last = await app.request('/api/login', login('ada@example.com'));
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(last!.headers.get('retry-after')).toMatch(/^(59|60)$/);
    expect(last!.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(await last!.json()).toEqual({ message: 'Too Many Attempts.' });
  });

  it('counts per key — another email has its own budget', async () => {
    const app = await boot();
    for (let i = 0; i < 3; i++) await app.request('/api/login', login('ada@example.com'));
    expect((await app.request('/api/login', login('grace@example.com'))).status).toBe(200);
  });

  it('reports the remaining budget and applies every limit of a limiter', async () => {
    const app = await boot();
    const first = await app.request('/api/items');
    // The tightest limit's headers — the one with the fewest attempts left, wherever it is in the list.
    expect([first.headers.get('x-ratelimit-limit'), first.headers.get('x-ratelimit-remaining')]).toEqual(['2', '1']);
    await app.request('/api/items');
    expect((await app.request('/api/items')).status).toBe(429);
  });

  it('shows the error page with Retry-After to browsers', async () => {
    const app = await boot();
    for (let i = 0; i < 3; i++) await app.request('/api/login', login('ada@example.com', 'text/html'));
    const page = await app.request('/api/login', login('ada@example.com', 'text/html'));
    expect(page.status).toBe(429);
    expect(page.headers.get('retry-after')).toBeTruthy();
    expect(await page.text()).toContain('Too Many Attempts.');
  });

  it('fails the start for an undefined limiter — not its first request', async () => {
    await expect(boot({ broken: true })).rejects.toThrow(
      "Rate limiter [nope] is not defined, but GET /api/broken uses throttle('nope'). Define it in a provider's boot(): app.container.make(RateLimiter).for('nope', …).",
    );
  });

  it('is named after its limiter (route:list)', () => {
    expect(throttle('login').name).toBe('throttle:login');
  });
});
