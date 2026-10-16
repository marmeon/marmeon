import { createApplication, defineModule, type Application } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, defineRequest, HttpServiceProvider, type ContextOf } from '@marmeon/http';
import { VALIDATE_HEADER } from '@marmeon/http/internal';
import { createHttpKernel } from '@marmeon/server';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { CacheServiceProvider } from './index.ts';
import { DEFAULT_LIVE_VALIDATION_LIMIT, Limit, RateLimiter, throttle, type LimiterCallback } from './rate-limiter.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const LoginRequest = defineRequest({ schema: v.object({ email: v.pipe(v.string(), v.email('Not an e-mail address.')) }) });
class LoginController extends Controller {
  static request = LoginRequest;
  handle(ctx: ContextOf<typeof LoginRequest>) {
    return this.json({ signedIn: ctx.body.email });
  }
}

async function boot(liveLimit?: LimiterCallback) {
  class Limits {
    boot(app: Application) {
      const limiter = app.container.make(RateLimiter).for('login', () => Limit.perMinute(3).by('everyone'));
      if (liveLimit) limiter.for('live-validation', liveLimit);
    }
  }
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, CacheServiceProvider, Limits],
    modules: [
      defineModule({
        name: 'live',
        apiRoutes: openRoutes((Route) => {
          Route.middleware(throttle('login')).post('/login', LoginController).name('login');
          Route.post('/subscribe', LoginController).name('subscribe');
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey(), CACHE_DRIVER: 'memory' } });
  return createHttpKernel(application);
}

const request = (email: string, live = true) => ({
  method: 'POST',
  body: JSON.stringify({ email }),
  headers: { 'content-type': 'application/json', accept: 'application/json', ...(live ? { [VALIDATE_HEADER]: 'email' } : {}) },
});

async function statuses(app: Awaited<ReturnType<typeof boot>>, path: string, count: number, live = true): Promise<number[]> {
  const result: number[] = [];
  for (let i = 0; i < count; i++) result.push((await app.request(path, request('ada@example.com', live))).status);
  return result;
}

describe('LimitLiveValidation', () => {
  it(`allows ${DEFAULT_LIVE_VALIDATION_LIMIT} live validations a minute per address and route, then 429 with Retry-After`, async () => {
    const app = await boot();
    const answers = await statuses(app, '/api/subscribe', DEFAULT_LIVE_VALIDATION_LIMIT);
    expect(answers.every((status) => status === 204)).toBe(true);
    const limited = await app.request('/api/subscribe', request('ada@example.com'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^(59|60)$/);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    // Its own counter: the form can still be sent, and another route still be checked.
    expect((await app.request('/api/subscribe', request('ada@example.com', false))).status).toBe(200);
    expect((await app.request('/api/login', request('ada@example.com'))).status).toBe(204);
  });

  it('counts a whole IPv6 /64 as one client — rotating the address inside it opens no new budget', async () => {
    const app = await boot();
    const answers: number[] = [];
    for (let i = 1; i <= DEFAULT_LIVE_VALIDATION_LIMIT + 1; i++) {
      const { headers, ...init } = request('ada@example.com');
      answers.push((await app.request('/api/subscribe', { ...init, headers }, { remoteAddress: `2001:db8:1:2::${i.toString(16)}` })).status);
    }
    expect(answers.at(-1)).toBe(429);
  });

  it("never counts against the route's own limit (the login's tries stay) — but is held to it", async () => {
    const app = await boot();
    // Five checks of the login form, then the three sign-ins its limit allows — none used up by the checks.
    expect(await statuses(app, '/api/login', 5)).toEqual([204, 204, 204, 204, 204]);
    expect(await statuses(app, '/api/login', 4, false)).toEqual([200, 200, 200, 429]);
    // The login's limit is used up: a check is refused too (no way around a limit).
    expect((await app.request('/api/login', request('ada@example.com'))).status).toBe(429);
  });

  it("an app sets its own: `limiter.for('live-validation', …)` — `Limit.none()` turns it off", async () => {
    const two = await boot(() => Limit.perMinute(2).by('everyone'));
    expect(await statuses(two, '/api/subscribe', 3)).toEqual([204, 204, 429]);
    const none = await boot(() => Limit.none());
    expect((await statuses(none, '/api/subscribe', DEFAULT_LIVE_VALIDATION_LIMIT + 5)).every((status) => status === 204)).toBe(true);
  });

  it('an unknown path has no route to validate: its 404 follows, nothing is counted', async () => {
    const app = await boot();
    const response = await app.request('/api/nowhere', request('ada@example.com'));
    expect(response.status).toBe(404);
  });
});
