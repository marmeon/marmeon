import { ConsoleLogger, createApplication, defineModule, Logger, type Container, type ErrorReport, type ErrorReporter } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { AfterResponse, defer, HttpError, HttpServiceProvider, view, type HttpContext, type SsrRender } from '@marmeon/http';
import type { Next } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel } from './kernel.ts';
import { createDocumentRenderer } from './render.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const PASSWORD = 'hunter2-s3cr3t';
const SECRET_PROP = 'prop-value-s3cr3t';
const BODY_SECRET = 'body-value-s3cr3t';
const COOKIE_SECRET = 'cookie-value-s3cr3t';
const HEADER_SECRET = 'header-value-s3cr3t';

const reports: ErrorReport[] = [];
let flushed = 0;
/** Set by a test: what the reporter does with each report, in its own context (it asks the app for another failing request). */
let reaction: (() => Promise<unknown>) | undefined;
class Collecting implements ErrorReporter {
  async report(report: ErrorReport): Promise<void> {
    reports.push(report);
    await reaction?.();
  }
  async flush(): Promise<void> {
    flushed++;
  }
}
const errorLines: string[] = [];
class CountingLogger extends ConsoleLogger {
  override error(message: string): void {
    errorLines.push(message);
  }
  override child(): Logger {
    return this;
  }
}
class LoggingProvider {
  register(container: Container) {
    container.singleton(Logger, () => new CountingLogger());
  }
}
class ReportingProvider {
  static errorReporters = [Collecting];
}

/** A UI-free SSR entry: the shell, then each deferred group as the server resolves it. */
const render: SsrRender = async (page, options = {}) => {
  const groups = Object.keys(page.deferredProps ?? {});
  const encoder = new TextEncoder();
  const html = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('<main>shell</main>'));
      await Promise.all(groups.map(async (group) => controller.enqueue(encoder.encode(JSON.stringify(await options.resolveDeferred?.(group))))));
      controller.close();
    },
  });
  return { html, streamedProps: groups };
};

class AfterResponseFails {
  readonly #after: AfterResponse;
  constructor(after: AfterResponse) {
    this.#after = after;
  }
  handle() {
    this.#after.defer(() => {
      throw new Error(`mail transport refused postgres://app:${PASSWORD}@db.internal/shop`);
    });
    return 'accepted';
  }
}

class Client404Deferred {
  readonly #after: AfterResponse;
  constructor(after: AfterResponse) {
    this.#after = after;
  }
  handle() {
    this.#after.defer(() => {
      throw new HttpError(404);
    });
    return 'accepted';
  }
}

class SameErrorTwice {
  readonly #after: AfterResponse;
  constructor(after: AfterResponse) {
    this.#after = after;
  }
  async handle() {
    const failure = Promise.reject(new Error('shared failure'));
    failure.catch(() => {});
    this.#after.defer(() => failure);
    await failure;
  }
}

const SHARED = new Error('module-wide failure');
class ThrowsShared {
  handle(): never {
    throw SHARED;
  }
}
class ThrowsPrimitiveLate {
  readonly #after: AfterResponse;
  constructor(after: AfterResponse) {
    this.#after = after;
  }
  handle() {
    this.#after.defer(() => {
      throw 'text';
    });
    return 'accepted';
  }
}
class ThrowsPrimitive {
  handle(): never {
    throw null;
  }
}

class Terminating {
  handle(_ctx: HttpContext, next: Next<{}>) {
    return next();
  }
  terminate(ctx: HttpContext): void {
    if (new URL(ctx.request.url).pathname === '/terminate') throw new Error(`terminate refused postgres://app:${PASSWORD}@db.internal/shop`);
  }
}

const routes = openRoutes((Route) => {
  Route.get('/page/:token', (ctx: HttpContext<{}, { token: string }>) =>
    view('pages/Show', {
      report: defer(() => {
        throw new Error(`group failed for ${SECRET_PROP} postgres://app:${PASSWORD}@db.internal/shop ${ctx.params.token}`);
      }),
    }),
  ).name('page.show');
  Route.get('/page-ok', () => view('pages/Show', { report: defer(() => 'fine') }));
  Route.get('/after', AfterResponseFails).name('after');
  Route.post('/after-body', AfterResponseFails);
  Route.get('/client-404', Client404Deferred);
  Route.get('/shared', ThrowsShared);
  Route.get('/primitive-late', ThrowsPrimitiveLate);
  Route.get('/primitive', ThrowsPrimitive);
  Route.get('/twice', SameErrorTwice);
  Route.get('/terminate', () => 'ok');
  Route.get('/looping', () => view('pages/Show', {
    report: defer(() => {
      throw new Error('looping group');
    }),
  }));
});

async function boot() {
  const application = await createApplication(
    {
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ReportingProvider, LoggingProvider],
      middleware: { web: [Terminating] },
      modules: [defineModule({ name: 'late', routes })],
    },
    { env: { APP_KEY: generateKey() } },
  );
  const renderer = createDocumentRenderer({ template: () => FALLBACK_TEMPLATE, ssr: () => render });
  return { application, kernel: createHttpKernel(application, { renderer }) };
}

const secretHeaders = { cookie: `session=${COOKIE_SECRET}`, authorization: `Bearer ${HEADER_SECRET}` };

describe('createHttpKernel — errors after the response goes to the error reporters', () => {
  it('reports a deferred group that fails while it streams, as a request error in its phase, without any secret', async () => {
    reports.length = 0;
    const { kernel } = await boot();
    const response = await kernel.request('/page/tok3n-value', { headers: secretHeaders });
    expect(response.status).toBe(200);
    await response.text();
    await kernel.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ source: 'request', context: { method: 'GET', route: 'page.show', phase: 'deferred' } });
    const seen = JSON.stringify(reports[0]);
    for (const secret of [PASSWORD, COOKIE_SECRET, HEADER_SECRET]) expect(seen).not.toContain(secret);
    expect(Object.keys(reports[0]!.context).sort()).toEqual(['method', 'path', 'phase', 'route']);
  });

  it('reports no group that succeeds', async () => {
    reports.length = 0;
    const { kernel } = await boot();
    await (await kernel.request('/page-ok')).text();
    await kernel.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(0);
  });

  it('reports afterResponse.defer() work that fails, masked', async () => {
    reports.length = 0;
    const { kernel } = await boot();
    await kernel.request('/after', { headers: secretHeaders });
    await kernel.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ source: 'request', context: { method: 'GET', route: 'after', path: '/after', phase: 'after-response' } });
    const seen = JSON.stringify(reports[0]);
    for (const secret of [PASSWORD, COOKIE_SECRET, HEADER_SECRET]) expect(seen).not.toContain(secret);
    expect(Object.keys(reports[0]!.context).sort()).toEqual(['method', 'path', 'phase', 'route']);
  });

  it('keeps the request body out of the report of work after the response', async () => {
    reports.length = 0;
    const { kernel } = await boot();
    await kernel.request('/after-body', { method: 'POST', headers: { 'content-type': 'application/json', ...secretHeaders }, body: JSON.stringify({ password: BODY_SECRET }) });
    await kernel.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports[0])).not.toContain(BODY_SECRET);
    expect(Object.keys(reports[0]!.context).sort()).toEqual(['method', 'path', 'phase', 'route']);
  });

  it('does not report a client error of work after the response', async () => {
    reports.length = 0;
    const { kernel } = await boot();
    await kernel.request('/client-404');
    await kernel.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(0);
  });

  it('logs the error of work after the response once, and reports the same error object once', async () => {
    reports.length = 0;
    errorLines.length = 0;
    const { kernel } = await boot();
    await kernel.request('/after');
    await kernel.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorLines).toEqual(['Deferred work failed']);

    reports.length = 0;
    await kernel.request('/twice', { headers: { accept: 'application/json' } });
    await kernel.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.context).not.toHaveProperty('phase');
  });

  it('reports a terminate hook that fails, and the reporters are flushed when the app shuts down', async () => {
    reports.length = 0;
    flushed = 0;
    const { application, kernel } = await boot();
    await kernel.request('/terminate', { headers: secretHeaders });
    await kernel.settle();
    await application.shutdown();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ source: 'request', context: { path: '/terminate', phase: 'terminate' } });
    const seen = JSON.stringify(reports[0]);
    for (const secret of [PASSWORD, COOKIE_SECRET, HEADER_SECRET]) expect(seen).not.toContain(secret);
    expect(Object.keys(reports[0]!.context).sort()).toEqual(['method', 'path', 'phase', 'route']);
    expect(flushed).toBe(1);
  });

  it('reports a failure that recurs with the same error object in every request', async () => {
    reports.length = 0;
    const { kernel } = await boot();
    for (let i = 0; i < 2; i++) await kernel.request('/shared', { headers: { accept: 'application/json' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(2);
  });

  it('reports a thrown primitive once, in a controller and in work after the response', async () => {
    reports.length = 0;
    const { kernel } = await boot();
    await kernel.request('/primitive', { headers: { accept: 'application/json' } });
    await kernel.request('/primitive-late');
    await kernel.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toHaveLength(2);
    expect(reports[1]!.context).toMatchObject({ phase: 'after-response' });
  });

  it('does not loop when a reporter makes the app fail after a response again', async () => {
    reports.length = 0;
    const { kernel } = await boot();
    // The reporter asks for a page whose deferred group fails: its error is the reporter's own, not reported again.
    reaction = async () => {
      await (await kernel.request('/looping')).text();
      await kernel.settle();
    };
    try {
      await (await kernel.request('/looping')).text();
      await kernel.settle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      reaction = undefined;
    }
    expect(reports).toHaveLength(1);
  });
});
