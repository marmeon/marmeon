import { createApplication, defineModule, ErrorSolutions, Logger, Redactor, type Container, type LogContext } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { ExceptionHandler, HttpServiceProvider, island, SharedData, view, type HttpContext, type SsrRender } from '@marmeon/http';
import type { Next } from '@marmeon/router';
import { openRoutes } from './test-helpers/open-routes.ts';
import { describe, expect, it } from 'vitest';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel } from './kernel.ts';
import { createDocumentRenderer } from './render.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';

// A reset link's token (64 hex) in the path and a signed value in the query: what a URL in an error line must never carry out.
const PATH_SECRET = 'a1b2c3d4'.repeat(8);
const QUERY_SECRET = 'q7Zk29WmXp41vB8nRt5L';

/** Everything the kernel logged at `error` — message and context, as the log writes it. */
const entries: { message: string; context: LogContext }[] = [];
class MemoryLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(message: string, context: LogContext = {}): void {
    entries.push({ message, context });
  }
  child(): Logger {
    return this;
  }
}
class LoggingProvider {
  register(container: Container) {
    container.singleton(Logger, () => new MemoryLogger());
  }
}

/** A body whose stream fails with a secret-shaped URL in the error's message — reading it throws that error. */
const failingBody = () =>
  new ReadableStream({
    start(controller) {
      controller.error(new Error(`the body of /reset-password/${PATH_SECRET}?token=${QUERY_SECRET} could not be read`));
    },
  });

/** A UI-free SSR entry that asks the server for each island of the page (`props.islands`). */
const render: SsrRender = async (page, options = {}) => {
  const islands = (page.props as { islands?: string[] }).islands ?? [];
  const parts = await Promise.all(islands.map(async (url) => (options.resolveIsland ? JSON.stringify(await options.resolveIsland(url)) : '')));
  return { html: `<main>shell</main>${parts.join('')}` };
};

/** Shares a prop whose evaluation fails with a secret-shaped URL in its message — the page of the error response then fails too. */
class SharesAFailingProp {
  readonly #shared: SharedData;
  constructor(shared: SharedData) {
    this.#shared = shared;
  }
  handle(_ctx: HttpContext, next: Next<{}>) {
    (this.#shared as unknown as { share(key: string, value: unknown): void }).share('broken', () => {
      throw new Error(`shared prop failed for /reset-password/${PATH_SECRET}?token=${QUERY_SECRET}`);
    });
    return next();
  }
}

describe('createHttpKernel — what its error lines write', async () => {
  const routes = openRoutes((Route) => {
    Route.get('/page', (ctx: HttpContext) => view('pages/Show', { islands: (new URL(ctx.request.url).searchParams.get('islands') ?? '').split(',').filter(Boolean) }));
    Route.get('/islands/never/:token', () => new Promise(() => {}));
    // Answers as an island but not with an island's JSON: reading it fails.
    Route.get('/islands/garbled/:token', () => new Response(failingBody(), { headers: { 'x-marmeon-region': 'island', 'content-type': 'application/json' } }));
    Route.get('/islands/writes/:token', (ctx: HttpContext) => {
      ctx.cookies.set('tracking', 'yes');
      return island('log/Island', {});
    });
    // Answers as a page but not with a page's JSON: reading the layer's base fails.
    Route.get('/bases/:token', () => new Response(failingBody(), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, 'content-type': 'application/json' } })).name('bases.show');
    Route.get('/bases/:token/edit', (ctx: HttpContext<{}, { token: string }>) => view('bases/Edit', {}).layer({ base: 'bases.show', params: { token: ctx.params.token } }));
    Route.get('/fails', () => {
      throw new Error('the controller failed');
    });
  });
  class FailingSolutions {
    register(container: Container) {
      container.instance(ErrorSolutions, {
        find: () => {
          throw new Error(`looking up a solution failed for /reset-password/${PATH_SECRET}?token=${QUERY_SECRET}`);
        },
      } as unknown as ErrorSolutions);
    }
  }
  class FailingHandler {
    register(container: Container) {
      container.instance(ExceptionHandler, {
        render: () => {
          throw new Error(`rendering failed for /reset-password/${PATH_SECRET}?token=${QUERY_SECRET}`);
        },
      });
    }
  }
  const create = async (extra: { sharing?: boolean; solutions?: boolean; rendering?: boolean }) =>
    createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, LoggingProvider, ...(extra.solutions ? [FailingSolutions] : []), ...(extra.rendering ? [FailingHandler] : [])],
      ...(extra.sharing ? { middleware: { web: [SharesAFailingProp] } } : {}),
      modules: [defineModule({ name: 'log', routes })],
    }, { env: { APP_KEY: generateKey() } });
  const renderer = createDocumentRenderer({ template: () => FALLBACK_TEMPLATE, ssr: () => render });
  const application = await create({});
  application.container.make(Redactor);
  const app = createHttpKernel(application, { renderer, islandTimeoutMs: 50 });

  /** Runs `act`, then proves the error lines it wrote exist and carry no part of the secrets. */
  const logsMasked = async (act: () => Promise<unknown>, expected: RegExp) => {
    entries.length = 0;
    await act();
    const written = JSON.stringify(entries);
    expect(entries.some((entry) => expected.test(entry.message)), `no error line like ${expected}: ${written}`).toBe(true);
    expect(written, 'the path secret reached the log').not.toContain(PATH_SECRET);
    expect(written, 'the query secret reached the log').not.toContain(QUERY_SECRET);
  };
  const text = async (response: Response | Promise<Response>) => (await response).text();
  const islandsPage = (...urls: string[]) => app.request(`/page?islands=${urls.map(encodeURIComponent).join(',')}`);

  it('refuses the old islandTimeout, which no type check may have seen', () => {
    const options = { renderer, islandTimeout: 50 };
    expect(() => createHttpKernel(application, options)).toThrow(/islandTimeoutMs/);
  });

  it('masks the URL of an island from another site', async () => {
    await logsMasked(
      () => text(islandsPage(`https://other.example/reset-password/${PATH_SECRET}?token=${QUERY_SECRET}`)),
      /^An island comes from this site, not from https:\/\/other\.example \(/,
    );
  });

  it('masks the URL of an island that takes too long', async () => {
    await logsMasked(
      () => text(islandsPage(`/islands/never/${PATH_SECRET}?token=${QUERY_SECRET}`)),
      /^The island .* took longer than 50 ms/,
    );
  });

  it('masks the URL and the error of an island that fails to resolve', async () => {
    await logsMasked(
      () => text(islandsPage(`/islands/garbled/${PATH_SECRET}?token=${QUERY_SECRET}`)),
      /^Resolving the island .* failed$/,
    );
  });

  it('masks the URL and the error of a layer base that fails to resolve', async () => {
    await logsMasked(() => text(app.request(`/bases/${PATH_SECRET}/edit`)), /^Resolving the layer base .* failed$/);
  });

  it('masks the path in the read-only report of an island that writes — as the default of a protected environment logs it', async () => {
    const lenient = createHttpKernel(application, { renderer, islandTimeoutMs: 50, strictReadOnly: false });
    await logsMasked(
      () => text(lenient.request(`/islands/writes/${PATH_SECRET}?token=${QUERY_SECRET}`, { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, 'x-marmeon-region': 'island' } })),
      /^cookies\.set\('tracking'\) in an island request \(GET .*\).* \(dropped\)$/,
    );
  });

  it('masks the error of an island whose error response fails to render', async () => {
    const failing = createHttpKernel(await create({ rendering: true }), { renderer, islandTimeoutMs: 50 });
    await logsMasked(
      () => text(failing.request('/fails', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, 'x-marmeon-region': 'island' } })),
      /^Rendering the error of an island failed$/,
    );
  });

  it('masks the error of an error response that fails to render', async () => {
    const sharing = createHttpKernel(await create({ sharing: true }), { renderer, islandTimeoutMs: 50 });
    await logsMasked(() => text(sharing.request('/fails', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } })), /^Rendering the error response failed$/);
  });

  it('masks the error of a development error page that fails to render', async () => {
    const developing = createHttpKernel(await create({ solutions: true }), { renderer, debug: true, islandTimeoutMs: 50 });
    await logsMasked(() => text(developing.request('/fails', { headers: { accept: 'text/html' } })), /^Rendering the development error page failed$/);
  });
});
