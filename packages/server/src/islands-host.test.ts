import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication, defineModule } from '@marmeon/core';
import { devHosts, devOnly } from '@marmeon/core/dev';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, island, view, type EmptyObject, type HttpContext, type RegionResult, type SsrRender } from '@marmeon/http';
import type { Next } from '@marmeon/router';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel } from './kernel.ts';
import { writeLastError, type LastErrorWriter } from './last-error.ts';
import { ServerServiceProvider } from './provider.ts';
import { createDocumentRenderer } from './render.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

/** A UI-free SSR entry that resolves each island of the page (`props.islands`) in-process. */
const render: SsrRender = async (page, options = {}) => {
  const islands = (page.props as { islands?: string[] }).islands ?? [];
  const parts = await Promise.all(
    islands.map(async (url) => `<island url="${url}">${JSON.stringify(options.resolveIsland ? await options.resolveIsland(url) : { status: 'browser' })}</island>`),
  );
  return { html: `<main>shell</main>${parts.join('')}` };
};

const islandsOf = (html: string) =>
  Object.fromEntries([...html.matchAll(/<island url="([^"]+)">(.*?)<\/island>/g)].map(([, url, json]) => [url!, JSON.parse(json!) as RegionResult]));

/** The guard of a development route as a middleware, as docs/routing.md shows it. */
class DevelopmentOnly {
  readonly #guard = devOnly(devHosts(undefined), (_ctx: HttpContext, next: Next<EmptyObject>) => next());
  handle(ctx: HttpContext, next: Next<EmptyObject>): Promise<Response> {
    return this.#guard(ctx, next);
  }
}

const writers: LastErrorWriter[] = [];
afterEach(() => {
  for (const writer of writers.splice(0)) writer.close();
});

describe('an island asks for the host its page was asked for', async () => {
  const root = tempDir('marmeon-island-host-');
  const routes = openRoutes((Route) => {
    Route.get('/page', (ctx: HttpContext) => view('pages/Show', { islands: (new URL(ctx.request.url).searchParams.get('islands') ?? '').split(',').filter(Boolean) }));
    Route.get('/islands/boom', () => {
      throw new Error('text of the attacker’s choice');
    });
    Route.middleware(DevelopmentOnly).get('/islands/dev', () => island('islands/Dev', {}));
  });
  const application = await createApplication({
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    modules: [defineModule({ name: 'island-host', routes })],
  }, { env: { APP_KEY: generateKey(), NODE_ENV: 'development', TRUSTED_PROXIES: '127.0.0.1' } });
  const app = createHttpKernel(application, { renderer: createDocumentRenderer({ template: () => FALLBACK_TEMPLATE, ssr: () => render }), debug: true });
  // The proxy is trusted, so `X-Forwarded-Host` makes the request's URL `localhost` — the `Host` header stays the client's.
  const page = (host: string, islands: string[]) =>
    app.request(`/page?islands=${islands.join(',')}`, { headers: { host, 'x-forwarded-host': 'localhost', 'sec-fetch-site': 'same-origin' } }, { remoteAddress: '127.0.0.1' });

  it('writes no last-error.md for an island that fails under a foreign Host, however the proxy headers name the URL', async () => {
    const writer = writeLastError(application);
    writers.push(writer);
    await page('evil.example', ['/islands/boom']);
    await writer.idle();
    expect(existsSync(join(root, '.marmeon', 'last-error.md'))).toBe(false);
    await page('localhost:3000', ['/islands/boom']);
    await writer.idle();
    expect(existsSync(join(root, '.marmeon', 'last-error.md'))).toBe(true);
  });

  it('refuses a devOnly island under a foreign Host', async () => {
    const foreign = islandsOf(await (await page('evil.example', ['/islands/dev'])).text());
    expect(foreign['/islands/dev']).toEqual({ status: 'forbidden' });
    const own = islandsOf(await (await page('localhost:3000', ['/islands/dev'])).text());
    expect(own['/islands/dev']).toMatchObject({ status: 'ready' });
  });
});
