import { createApplication, defineConfig, defineModule, env, type ConfigOf } from '@marmeon/core';
import { devHosts, devOnly } from '@marmeon/core/dev';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import type { EmptyObject, HttpContext, Next } from '@marmeon/router';
import { openRoutes } from './test-helpers/open-routes.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';

// An app's own development route (the routing page's "Development-only routes"): APP_URL comes from the app's config, which reads
// .env as well as the environment — a route file has neither, and `process.env.APP_URL` misses a value from .env.
const AppConfig = defineConfig('app', {
  env: env({ APP_URL: env.url() }),
  resolve: (e) => ({ url: e.APP_URL }),
});
type AppConfig = ConfigOf<typeof AppConfig>;

class DevelopmentOnly {
  readonly #guard: (ctx: HttpContext, next: Next<EmptyObject>) => Promise<Response>;

  constructor(app: AppConfig) {
    this.#guard = devOnly(devHosts(app.url), (_ctx: HttpContext, next: Next<EmptyObject>) => next());
  }

  handle(ctx: HttpContext, next: Next<EmptyObject>): Promise<Response> {
    return this.#guard(ctx, next);
  }
}

describe("an app's development route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers the host of APP_URL from the app's config — a guard built from process.env answers the loopback names only", async () => {
    // The real environment without APP_URL — the app has it from .env.
    vi.stubEnv('APP_URL', '');
    const application = await createApplication({
      root: import.meta.dirname,
      discover: false,
      // The app's environment (what .env gives it) — not process.env.
      env: { APP_KEY: generateKey(), APP_URL: 'http://shop.test:3960' },
      config: [AppConfig],
      providers: [EncryptionServiceProvider, HttpServiceProvider],
      modules: [
        defineModule({
          name: 'playground',
          routes: openRoutes((Route) => {
            Route.middleware(DevelopmentOnly).get('/_playground', () => new Response('playground'));
            Route.get('/_playground/env', devOnly(devHosts(process.env.APP_URL), () => new Response('playground')));
          }),
        }),
      ],
    });
    const app = createHttpKernel(application);
    const at = (path: string, host: string) => app.request(path, { headers: { host } });
    expect([(await at('/_playground', 'shop.test:3960')).status, (await at('/_playground', 'localhost:3960')).status, (await at('/_playground', 'evil.example')).status]).toEqual([200, 200, 403]);
    expect((await at('/_playground/env', 'shop.test:3960')).status).toBe(403);
  });
});

describe('the peer of a development route', () => {
  afterEach(() => vi.unstubAllEnvs());

  const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
  const PEER_TEXT = 'Development routes answer only connections from this machine.';

  const boot = async (proxies?: string) => {
    vi.stubEnv('NODE_ENV', 'development');
    let ran = 0;
    const application = await createApplication({
      root: import.meta.dirname,
      discover: false,
      env: { APP_KEY: generateKey(), ...(proxies === undefined ? {} : { TRUSTED_PROXIES: proxies }) },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
      modules: [
        defineModule({
          name: 'playground',
          routes: openRoutes((Route) => {
            Route.get('/_playground', devOnly(devHosts(undefined), () => (ran++, new Response('playground'))));
            Route.get('/open', () => new Response('open'));
          }),
        }),
      ],
    });
    const app = createHttpKernel(application);
    const get = async (path: string, from?: string, headers: Record<string, string> = {}) => {
      const response = await app.request(path, { headers: { host: 'localhost:3960', ...headers } }, from === undefined ? undefined : peer(from));
      return { status: response.status, text: await response.text() };
    };
    return { get, ran: () => ran };
  };

  it.each(['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1'])('answers a loopback peer: %s', async (from) => {
    const { get } = await boot();
    expect((await get('/_playground', from)).status).toBe(200);
  });

  it.each(['192.168.1.20', '172.17.0.1', '10.0.0.5', '::ffff:192.168.1.20', 'fe80::1'])('refuses another machine, although it sends Host: localhost: %s', async (from) => {
    const { get, ran } = await boot();
    const refused = await get('/_playground', from);
    expect(refused.status).toBe(403);
    expect(refused.text).toContain(PEER_TEXT);
    expect(ran()).toBe(0);
  });

  it('answers a request without a peer (in-process) and leaves routes that are not development routes alone', async () => {
    const { get } = await boot();
    expect((await get('/_playground')).status).toBe(200);
    expect(await get('/open', '192.168.1.20')).toEqual({ status: 200, text: 'open' });
  });

  it('behind a trusted proxy on this machine, the client it names counts too', async () => {
    const { get } = await boot('127.0.0.1');
    expect((await get('/_playground', '127.0.0.1', { 'x-forwarded-for': '192.168.1.20' })).status).toBe(403);
    expect((await get('/_playground', '127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })).status).toBe(200);
    expect((await get('/_playground', '127.0.0.1')).status).toBe(200);
  });

  it("TRUSTED_PROXIES='*': a client writing X-Forwarded-For: 127.0.0.1 is not local", async () => {
    const { get } = await boot('*');
    expect((await get('/_playground', '192.168.1.20', { 'x-forwarded-for': '127.0.0.1' })).status).toBe(403);
  });
});
