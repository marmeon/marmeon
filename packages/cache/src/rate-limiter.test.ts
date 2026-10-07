import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineRoutes, HttpServiceProvider } from '@marmeon/http';
import { createHttpKernel } from '@marmeon/server';
import { describe, expect, it } from 'vitest';
import { CacheServiceProvider } from './index.ts';
import { Limit, RateLimiter, throttle } from './rate-limiter.ts';

class LoginLimits {
  boot(app: { container: { make(key: typeof RateLimiter): RateLimiter } }) {
    app.container
      .make(RateLimiter)
      .for('login', async (ctx) => Limit.perMinute(3).by(`${String((await ctx.input()).email)}|${ctx.ip ?? ''}`))
      .for('api', () => [Limit.perMinute(100), Limit.perSecond(2)]);
  }
}

async function boot() {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), CACHE_DRIVER: 'memory' },
    providers: [EncryptionServiceProvider, HttpServiceProvider, CacheServiceProvider, LoginLimits],
    modules: [
      defineModule({
        name: 'limits',
        apiRoutes: defineRoutes((Route) => {
          Route.middleware(throttle('login')).post('/login', () => ({ ok: true }));
          Route.middleware(throttle('api')).get('/items', () => []);
          Route.middleware(throttle('nope')).get('/broken', () => []);
        }),
      }),
    ],
  });
  return createHttpKernel(application);
}

const login = (email: string, accept = 'application/json') => ({
  method: 'POST',
  body: JSON.stringify({ email }),
  headers: { 'content-type': 'application/json', accept },
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
    expect(first.headers.get('x-ratelimit-remaining')).toBe('1'); // the stricter per-second limit, reported last
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

  it('names an undefined limiter', async () => {
    const response = await (await boot()).request('/api/broken', { headers: { accept: 'application/json' } });
    expect(response.status).toBe(500);
  });

  it('is named after its limiter (route:list)', () => {
    expect(throttle('login').name).toBe('throttle:login');
  });
});
