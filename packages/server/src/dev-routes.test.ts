import { createApplication, defineConfig, defineModule, env, type ConfigOf } from '@marmeon/core';
import { devHosts, devOnly } from '@marmeon/core/dev';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { contentSecurityPolicy, HttpServiceProvider } from '@marmeon/http';
import { defineMiddleware, type EmptyObject, type HttpContext, type Next } from '@marmeon/router';
import { openRoutes } from './test-helpers/open-routes.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpKernel } from './kernel.ts';

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
    }, { env: { APP_KEY: generateKey(), APP_URL: 'http://shop.test:3960' } });
    const app = createHttpKernel(application);
    const at = (path: string, host: string) => app.request(path, { headers: { host } });
    expect([(await at('/_playground', 'shop.test:3960')).status, (await at('/_playground', 'localhost:3960')).status, (await at('/_playground', 'evil.example')).status]).toEqual([200, 200, 403]);
    expect((await at('/_playground/env', 'shop.test:3960')).status).toBe(403);
  });

  it("keeps the global Content-Security-Policy on a page behind devOnly() — the page's nonce is the header's, as a route handler and as a middleware", async () => {
    const hosts = devHosts(undefined);
    const page = (ctx: HttpContext) => new Response(`<script nonce="${ctx.nonce()}">ok()</script>`, { headers: { 'content-type': 'text/html' } });
    const application = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider],
      middleware: { global: [contentSecurityPolicy()] },
      modules: [
        defineModule({
          name: 'playground',
          routes: openRoutes((Route) => {
            Route.get('/_playground/handler', devOnly(hosts, page));
            Route.middleware(defineMiddleware('DevOnly', devOnly(hosts, (_ctx: HttpContext, next: Next<EmptyObject>) => next()))).get('/_playground/middleware', page);
          }),
        }),
      ],
    }, { env: { APP_KEY: generateKey(), NODE_ENV: 'test' } });
    const app = createHttpKernel(application);
    for (const path of ['/_playground/handler', '/_playground/middleware']) {
      const response = await app.request(path, { headers: { host: 'localhost:3960' } });
      const nonce = /script-src 'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
      expect(nonce, path).toBeDefined();
      expect(await response.text(), path).toContain(`<script nonce="${nonce}">`);
      expect(response.headers.get('x-frame-options'), path).toBe('SAMEORIGIN');
    }
  });
});
