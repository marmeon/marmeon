import { createApplication, defineModule, Logger, type Application, type LogContext } from '@bespokecore/core';
import { channels, messageBase, publishEnded, type ExceptionMessage, type HttpRequestMessage, type SsrRenderMessage } from '@bespokecore/core/diagnostics';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { abort, Controller, HttpServiceProvider, view } from '@bespokecore/http';
import { defineRoutes } from '@bespokecore/router';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';

/** The app of the current test — the controller reports a query for it. */
let current: Application | undefined;

class ShowUserController extends Controller {
  handle() {
    // A query while the request runs — as the database would report it (on the app's channel, in the request's context).
    const app = current;
    if (app && channels.tracing('db.query').hasSubscribers) {
      publishEnded(channels.tracing('db.query'), { ...messageBase(app), connection: 'default', driver: 'sqlite', sql: 'select * from users where id = ?', parameters: [7], secret: true, durationMs: 2.5 });
    }
    return { id: 7 };
  }
}

const routes = defineRoutes((Route) => {
  Route.get('/users/:user', ShowUserController).name('users.show');
  Route.get('/ping', () => ({ pong: true }));
  Route.get('/boom', () => {
    throw new Error('the cache is down');
  });
  Route.get('/forbidden', () => abort(403, 'Only admins.'));
  Route.get('/home', () => view('Home', { greeting: 'hi' }));
});

const lines: { message: string; context: LogContext }[] = [];
class Lines implements Logger {
  debug() {}
  info(message: string, context: LogContext = {}) {
    lines.push({ message, context });
  }
  warn() {}
  error() {}
  child(): Logger {
    return this;
  }
}

async function boot(env: Record<string, string> = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    modules: [defineModule({ name: 'diagnostics', routes })],
    override: (container) => container.instance(Logger, new Lines()),
  });
  current = application;
  return { application, kernel: createHttpKernel(application) };
}

describe('the http.request channel (E118)', () => {
  it('traces a request: route name, pattern, controller, status, duration — with the request id it answers with', async () => {
    const { application, kernel } = await boot();
    const ended: HttpRequestMessage[] = [];
    const off = channels.subscribe(application, 'http.request', { end: (message) => void ended.push(message) });
    try {
      const response = await kernel.request('/users/7', { headers: { 'x-request-id': 'req-42' } });
      expect(response.status).toBe(200);
      await kernel.request('/ping');
      await kernel.request('/nowhere');
    } finally {
      off();
    }
    expect(ended).toHaveLength(3);
    expect(ended[0]).toMatchObject({ app: application, requestId: 'req-42', method: 'GET', path: '/users/7', route: 'users.show', routePath: '/users/:user', controller: 'ShowUserController', status: 200, inProcess: false });
    expect(ended[0]!.durationMs).toBeGreaterThan(0);
    // A closure has no controller, an unnamed route no name; an unknown path matched nothing.
    expect(ended[1]).toMatchObject({ path: '/ping', routePath: '/ping', status: 200 });
    expect(ended[1]).not.toHaveProperty('route');
    expect(ended[1]).not.toHaveProperty('controller');
    expect(ended[2]).toMatchObject({ path: '/nowhere', status: 404 });
    expect(ended[2]).not.toHaveProperty('routePath');
    await application.shutdown();
  });

  it('builds no message while nobody listens — not one, for any channel', async () => {
    const { application, kernel } = await boot();
    for (const path of ['/users/7', '/ping', '/boom', '/forbidden', '/nowhere']) await kernel.request(path);
    expect(channels.built(application)).toBe(0);
    await application.shutdown();
  });

  it('writes the route name into the request\'s log line', async () => {
    const { application, kernel } = await boot();
    lines.length = 0;
    await kernel.request('/users/7');
    await kernel.request('/ping');
    expect(lines.map(({ message, context }) => [message, context.route])).toEqual([
      ['GET /users/7 200', 'users.show'],
      ['GET /ping 200', undefined],
    ]);
    expect(lines[0]!.context.ms).toBeTypeOf('number');
    await application.shutdown();
  });
});

describe('the render.ssr channel (E118)', () => {
  it('traces server rendering of a document — its view, whether it streams; a failure with its error (the browser renders)', async () => {
    const { application } = await boot();
    let fail = false;
    const renderer = {
      render: async () => {
        if (fail) throw new Error('window is not defined');
        return new ReadableStream<Uint8Array>();
      },
      shell: async () => '<!doctype html><div id="app"></div>',
    };
    const kernel = createHttpKernel(application, { renderer });
    const ended: SsrRenderMessage[] = [];
    const off = channels.subscribe(application, 'render.ssr', { end: (message) => void ended.push(message) });
    try {
      await kernel.request('/home', { headers: { 'x-request-id': 'req-ssr' } });
      fail = true;
      expect((await kernel.request('/home')).status).toBe(200);
      // A page object (a client-side visit) is not rendered on the server.
      await kernel.request('/home', { headers: { 'x-bespoke': 'true' } });
    } finally {
      off();
    }
    expect(ended.map(({ component, complete, streamed, requestId }) => ({ component, complete, streamed, requestId }))).toEqual([
      { component: 'Home', complete: false, streamed: true, requestId: 'req-ssr' },
      { component: 'Home', complete: false, streamed: undefined, requestId: expect.any(String) },
    ]);
    expect((ended[1]!.error as Error).message).toBe('window is not defined');
    await application.shutdown();
  });
});

describe('the exception channel (E118)', () => {
  it('carries the error a request ended in, its status and the request id', async () => {
    const { application, kernel } = await boot();
    const errors: ExceptionMessage[] = [];
    const off = channels.subscribe(application, 'exception', (message) => void errors.push(message));
    try {
      await kernel.request('/boom', { headers: { 'x-request-id': 'req-boom', accept: 'application/json' } });
      await kernel.request('/forbidden', { headers: { accept: 'application/json' } });
    } finally {
      off();
    }
    expect(errors.map(({ status, path, method }) => ({ status, path, method }))).toEqual([
      { status: 500, path: '/boom', method: 'GET' },
      { status: 403, path: '/forbidden', method: 'GET' },
    ]);
    expect((errors[0]!.error as Error).message).toBe('the cache is down');
    expect(errors[0]!.requestId).toBe('req-boom');
    await application.shutdown();
  });
});

describe('Server-Timing (E129)', () => {
  it('with NODE_ENV=development: app, db (time and count) — measured from the channels', async () => {
    const { application, kernel } = await boot({ NODE_ENV: 'development' });
    const response = await kernel.request('/users/7');
    expect(response.headers.get('server-timing')).toMatch(/^app;dur=[\d.]+;desc="App", db;dur=2\.5;desc="1 query"$/);
    expect((await kernel.request('/ping')).headers.get('server-timing')).toMatch(/^app;dur=[\d.]+;desc="App", db;dur=0;desc="0 queries"$/);
    // A server-rendered document: the time until its shell.
    const rendering = createHttpKernel(application, { renderer: { render: async () => '<!doctype html><p>hi</p>', shell: async () => '' } });
    expect((await rendering.request('/home')).headers.get('server-timing')).toMatch(/^app;dur=[\d.]+;desc="App", db;dur=0;desc="0 queries", ssr;dur=[\d.]+;desc="SSR"$/);
    await application.shutdown();
  });

  it.each(['production', 'test', 'staging'])('never with NODE_ENV=%s — development only, not "not production" (E115)', async (mode) => {
    const { application, kernel } = await boot({ NODE_ENV: mode });
    expect((await kernel.request('/users/7')).headers.has('server-timing')).toBe(false);
    expect(channels.tracing('db.query').hasSubscribers).toBe(false);
    await application.shutdown();
  });

  it('its subscriptions end with the app (the provider\'s shutdown)', async () => {
    const { application } = await boot({ NODE_ENV: 'development' });
    expect(channels.tracing('db.query').hasSubscribers).toBe(true);
    expect(channels.tracing('render.ssr').hasSubscribers).toBe(true);
    await application.shutdown();
    expect(channels.tracing('db.query').hasSubscribers).toBe(false);
    expect(channels.tracing('render.ssr').hasSubscribers).toBe(false);
  });
});
