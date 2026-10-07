import { ConsoleLogger, createApplication, currentRequest, defineModule, Logger, type Container } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import {
  abort,
  defer,
  HttpServiceProvider,
  island,
  ResponseLifecycle,
  view,
  type HttpContext,
  type PageObject,
  type RegionResult,
  type SsrRender,
} from '@marmeon/http';
import { defineRoutes, type Next } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel } from './kernel.ts';
import { createDocumentRenderer } from './render.ts';

/**
 * A UI-free SSR entry, as an adapter would be (E49): the shell at once, then each island of the page (`props.islands`) as
 * the server's `resolveIsland` answers it, then each deferred group — all in the same stream. `complete`: all of it first.
 */
const render: SsrRender = async (page, options = {}) => {
  const islands = (page.props as { islands?: string[] }).islands ?? [];
  const groups = Object.keys(page.deferredProps ?? {});
  const parts = [
    ...islands.map(async (url) => `<island url="${url}">${JSON.stringify(options.resolveIsland ? await options.resolveIsland(url) : { status: 'browser' })}</island>`),
    ...(options.complete || !options.resolveDeferred
      ? []
      : groups.map(async (group) => `<deferred group="${group}">${JSON.stringify(await options.resolveDeferred!(group))}</deferred>`)),
  ];
  const shell = '<main>shell</main>';
  if (options.complete) return { html: shell + (await Promise.all(parts)).join('') };
  const encoder = new TextEncoder();
  const html = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(shell));
      await Promise.all(parts.map((part) => part.then((chunk) => controller.enqueue(encoder.encode(chunk)))));
      controller.close();
    },
  });
  return { html, ...(options.resolveDeferred && !options.complete && groups.length > 0 ? { streamedProps: groups } : {}) };
};

/** A promise the test settles — what a slow island waits for. */
function later() {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => (settle = resolve));
  return { promise, settle };
}

const islandsOf = (html: string) =>
  Object.fromEntries([...html.matchAll(/<island url="([^"]+)">(.*?)<\/island>/g)].map(([, url, json]) => [url!, JSON.parse(json!) as RegionResult]));

describe('islands resolved in-process while the page streams (E49)', async () => {
  const logged: string[] = [];
  class CollectingLogger extends ConsoleLogger {
    override error(message: string): void {
      logged.push(message);
    }
    override child(): Logger {
      return this;
    }
  }
  class LoggingProvider {
    register(container: Container) {
      container.singleton(Logger, () => new CollectingLogger());
    }
  }
  const passed: string[] = [];
  /** The island route's own middleware — it runs for the island, not for the page. */
  class Counts {
    async handle(ctx: HttpContext, next: Next<{}>) {
      passed.push(new URL(ctx.request.url).pathname);
      return next();
    }
  }
  const slow = { gate: later() };
  const computed: { headersSent: boolean }[] = [];
  const routes = defineRoutes((Route) => {
    Route.get('/page', (ctx: HttpContext) =>
      view('pages/Show', { islands: (new URL(ctx.request.url).searchParams.get('islands') ?? '').split(',').filter(Boolean) }),
    );
    Route.get('/page/deferred', (ctx: HttpContext) => {
      const lifecycle = (ctx as unknown as { lifecycle?: ResponseLifecycle }).lifecycle;
      return view('pages/Show', {
        report: defer(() => {
          computed.push({ headersSent: lifecycle?.headersSent ?? false });
          return { at: new Date('2026-10-02T12:00:00.000Z') };
        }),
        late: defer(() => 'other group', 'later'),
      });
    });
    Route.get('/page/deferred-writes', (ctx: HttpContext) =>
      view('pages/Show', {
        report: defer(() => {
          ctx.cookies.set('written-late', 'yes');
          return 'written';
        }),
      }),
    );
    const islands = Route.middleware(Counts);
    islands.get('/islands/echo', (ctx: HttpContext) =>
      island('islands/Echo', {
        cookie: ctx.request.headers.get('cookie'),
        language: ctx.request.headers.get('accept-language'),
        purpose: ctx.request.headers.get('purpose'),
        requestId: currentRequest()?.requestId ?? null,
        ip: ctx.ip ?? null,
        at: new Date('2026-10-02T12:00:00.000Z'),
      }),
    );
    islands.get('/islands/slow', async () => {
      await slow.gate.promise;
      return island('islands/Slow', { done: true });
    });
    islands.get('/islands/never', () => new Promise(() => {}));
    islands.get('/islands/guarded', () => new Response(null, { status: 302, headers: { location: '/login' } }));
    islands.get('/islands/forbidden', () => abort(403, 'Admins only.'));
    islands.get('/islands/boom', () => {
      throw new Error('database password is hunter2');
    });
    islands.get('/islands/stale', () => new Response(null, { status: 409, headers: { 'x-marmeon-location': '/page' } }));
    islands.get('/islands/cookie', (ctx: HttpContext) => {
      ctx.cookies.set('tracking', 'yes');
      return island('islands/Echo', {});
    });
    Route.get('/not-an-island', () => view('pages/Show', {}));
  });
  /** Gives the deferred thunk of `/page/deferred` the request's lifecycle (to see when it runs). */
  class ExposesLifecycle {
    readonly #lifecycle: ResponseLifecycle;
    constructor(lifecycle: ResponseLifecycle) {
      this.#lifecycle = lifecycle;
    }
    handle(ctx: HttpContext, next: Next<{}>) {
      Object.assign(ctx, { lifecycle: this.#lifecycle });
      return next();
    }
  }
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey() },
    providers: [EncryptionServiceProvider, HttpServiceProvider, LoggingProvider],
    modules: [defineModule({ name: 'islands', routes })],
    middleware: { web: [ExposesLifecycle] },
  });
  const renderer = createDocumentRenderer({ template: () => FALLBACK_TEMPLATE, ssr: () => render });
  const app = createHttpKernel(application, { renderer, debug: true, islandTimeout: 100 });
  const production = createHttpKernel(application, { renderer, strictReadOnly: false, islandTimeout: 100 });
  const page = (islands: string[], init: RequestInit = {}) => app.request(`/page?islands=${islands.join(',')}`, init);

  it('runs each island through its own route’s middleware, in-process — with the page request’s cookies, languages and request id', async () => {
    passed.length = 0;
    const response = await page(['/islands/echo'], {
      headers: { cookie: 'theme=dark', 'accept-language': 'de', purpose: 'prefetch-not', 'x-request-id': 'page-1', 'x-forwarded-for': '203.0.113.9' },
    });
    expect(response.status).toBe(200);
    const result = islandsOf(await response.text())['/islands/echo']!;
    expect(result).toEqual({
      status: 'ready',
      region: {
        component: 'islands/Echo',
        // Serialized as for the browser (a Date is its string); nothing of the page's own request (`Purpose`).
        props: { cookie: 'theme=dark', language: 'de', purpose: null, requestId: 'page-1', ip: null, at: '2026-10-02T12:00:00.000Z' },
        url: '/islands/echo',
        version: null,
      },
    });
    // Its middleware ran for the island — the page's route has none.
    expect(passed).toEqual(['/islands/echo']);
  });

  it('turns what an island route answers into its outcome — as for the browser’s request, without data for a refused one', async () => {
    const response = await page(['/islands/guarded', '/islands/forbidden', '/islands/boom', '/not-an-island', '/islands/missing']);
    // The page answers as always — a redirect of an island never becomes the page's.
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    const html = await response.text();
    const results = islandsOf(html);
    expect(results['/islands/guarded']).toEqual({ status: 'unauthorized' });
    expect(results['/islands/forbidden']).toEqual({ status: 'forbidden' });
    expect(results['/islands/boom']).toMatchObject({ status: 'exception', failure: { status: 500 } });
    expect(results['/not-an-island']).toMatchObject({ status: 'exception', failure: { status: 404 } });
    expect(results['/islands/missing']).toMatchObject({ status: 'exception', failure: { status: 404 } });
    expect(html).not.toContain('/login');
  });

  it('leaves an island that answers 409 (the document is out of date) to the browser — its request reloads the page', async () => {
    const html = await (await page(['/islands/stale'])).text();
    expect(islandsOf(html)['/islands/stale']).toEqual({ status: 'browser' });
  });

  it('gives an island that takes too long its error — the page’s stream ends', async () => {
    logged.length = 0;
    const html = await (await page(['/islands/never'])).text();
    expect(islandsOf(html)['/islands/never']).toMatchObject({ status: 'exception', failure: { status: 504 } });
    expect(logged.some((message) => message.includes('took longer than 100 ms'))).toBe(true);
  });

  it('counter-check: a slow island never holds the headers back — the shell is out, the island follows in the same response', async () => {
    slow.gate = later();
    const started = performance.now();
    const response = await page(['/islands/slow', '/islands/echo']);
    const headers = performance.now() - started;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (!html.includes('<main>shell</main>')) html += decoder.decode((await reader.read()).value);
    expect(html).not.toContain('islands/Slow');
    setTimeout(() => slow.gate.settle(), 60);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value);
    }
    expect(headers).toBeLessThan(50);
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);
    expect(islandsOf(html)['/islands/slow']).toMatchObject({ status: 'ready', region: { props: { done: true } } });
  });

  it('leaves the islands of a prefetched document to the browser — islands never load ahead (E52)', async () => {
    passed.length = 0;
    const html = await (await page(['/islands/echo'], { headers: { 'sec-purpose': 'prefetch' } })).text();
    expect(islandsOf(html)['/islands/echo']).toEqual({ status: 'browser' });
    expect(passed).toEqual([]);
  });

  it('waits for every island for a bot (complete)', async () => {
    slow.gate = later();
    setTimeout(() => slow.gate.settle(), 30);
    const response = await page(['/islands/slow'], { headers: { 'user-agent': 'Googlebot/2.1' } });
    expect(islandsOf(await response.text())['/islands/slow']).toMatchObject({ status: 'ready' });
  });

  it('counter-check: an island stays read-only in-process — a cookie throws in development, and is dropped and logged in production', async () => {
    const strict = islandsOf(await (await page(['/islands/cookie'])).text())['/islands/cookie'];
    expect(strict).toMatchObject({ status: 'exception', failure: { status: 500 } });
    logged.length = 0;
    const lenient = await production.request('/page?islands=/islands/cookie');
    expect(islandsOf(await lenient.text())['/islands/cookie']).toMatchObject({ status: 'ready' });
    expect(lenient.headers.getSetCookie().join()).not.toContain('tracking');
    expect(logged.filter((message) => message.includes("cookies.set('tracking')"))).toHaveLength(1);
  });

  it('counter-check: concurrent pages never share an island’s request — each sees its own page’s cookies and request id', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => page(['/islands/echo'], { headers: { cookie: `user=${index}`, 'x-request-id': `page-${index}` } })),
    );
    const results = await Promise.all(responses.map(async (response) => islandsOf(await response.text())['/islands/echo']));
    results.forEach((result, index) => {
      expect(result).toMatchObject({ status: 'ready', region: { props: { cookie: `user=${index}`, requestId: `page-${index}` } } });
    });
  });

  it('streams deferred groups with the page — computed once the headers are out, serialized as for the browser', async () => {
    computed.length = 0;
    const response = await app.request('/page/deferred');
    const html = await response.text();
    const page = JSON.parse(/<script type="application\/json" id="marmeon-page">(.*?)<\/script>/.exec(html)![1]!) as PageObject;
    expect(page.streamedProps).toEqual(['default', 'later']);
    expect(html).toContain('<deferred group="default">{"props":{"report":{"at":"2026-10-02T12:00:00.000Z"}}}</deferred>');
    expect(html).toContain('<deferred group="later">{"props":{"late":"other group"}}</deferred>');
    expect(computed).toEqual([{ headersSent: true }]);
  });

  it('counter-check: a deferred prop that writes after the headers throws in development — the group is not streamed, the browser loads it', async () => {
    logged.length = 0;
    const response = await app.request('/page/deferred-writes');
    const html = await response.text();
    expect(html).toContain('<deferred group="default">null</deferred>');
    expect(response.headers.getSetCookie().join()).not.toContain('written-late');
    expect(logged.some((message) => message.includes('failed while streaming'))).toBe(true);
    // Production: dropped and logged — the group streams.
    logged.length = 0;
    const lenient = await (await production.request('/page/deferred-writes')).text();
    expect(lenient).toContain('<deferred group="default">{"props":{"report":"written"}}</deferred>');
    expect(logged.some((message) => message.includes("cookies.set('written-late') in GET /page/deferred-writes after its response headers were sent"))).toBe(true);
  });
});
