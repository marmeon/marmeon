import { createApplication, currentRequest, defineModule, Logger, type Container, type LogContext } from '@bespokecore/core';
import { abort, HttpServiceProvider } from '@bespokecore/http';
import { defineRoutes } from '@bespokecore/router';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

let created = 0;
class RequestId {
  readonly value = ++created;
}

class ShowRequestIdController {
  readonly #first: RequestId;
  readonly #second: RequestId;
  constructor(first: RequestId, second: RequestId) {
    this.#first = first;
    this.#second = second;
  }
  handle() {
    return { first: this.#first.value, second: this.#second.value };
  }
}

describe('createHttpKernel — container', async () => {
  class RequestScopeProvider {
    register(container: Container) {
      container.scoped(RequestId);
    }
  }
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [HttpServiceProvider, RequestScopeProvider],
    modules: [defineModule({ name: 'ids', routes: defineRoutes((Route) => Route.get('/id', ShowRequestIdController)) })],
  });
  const app = createHttpKernel(application);

  it('resolves controllers from a fresh scope per request', async () => {
    type Ids = { first: number; second: number };
    const one = (await (await app.request('/id')).json()) as Ids;
    const two = (await (await app.request('/id')).json()) as Ids;

    expect(one.first).toBe(one.second); // same instance within a request
    expect(two.first).not.toBe(one.first); // new instance for the next request
  });
});

describe('createHttpKernel — errors & logging', async () => {
  const entries: { level: string; message: string; context: Record<string, unknown> }[] = [];
  class MemoryLogger implements Logger {
    readonly #bindings: LogContext;
    constructor(bindings: LogContext = {}) {
      this.#bindings = bindings;
    }
    #log(level: string, message: string, context: LogContext = {}) {
      entries.push({ level, message, context: { ...this.#bindings, requestId: currentRequest()?.requestId, ...context } });
    }
    debug(message: string, context?: LogContext) {
      this.#log('debug', message, context);
    }
    info(message: string, context?: LogContext) {
      this.#log('info', message, context);
    }
    warn(message: string, context?: LogContext) {
      this.#log('warn', message, context);
    }
    error(message: string, context?: LogContext) {
      this.#log('error', message, context);
    }
    child(bindings: LogContext): Logger {
      return new MemoryLogger({ ...this.#bindings, ...bindings });
    }
  }
  class LoggingProvider {
    register(container: Container) {
      container.singleton(Logger, () => new MemoryLogger());
    }
  }

  const routes = defineRoutes((Route) => {
    Route.get('/boom', () => {
      throw new Error('database password is hunter2');
    });
    Route.get('/forbidden', () => abort(403, 'Only admins.'));
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [HttpServiceProvider, LoggingProvider],
    modules: [defineModule({ name: 'errors', routes })],
  });
  const app = createHttpKernel(application);
  const debugApp = createHttpKernel(application, { debug: true });
  const json = { headers: { accept: 'application/json' } };
  const page = { headers: { 'x-bespoke': 'true' } };

  it('hides unexpected errors from clients, but reports them with the request id', async () => {
    entries.length = 0;
    const response = await app.request('/boom', { headers: { ...json.headers, 'x-request-id': 'req-1' } });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: 'Server Error' });
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(entries.find((entry) => entry.level === 'error')).toMatchObject({
      message: 'database password is hunter2',
      context: { requestId: 'req-1', exception: 'Error' },
    });
  });

  it('shows exception details in debug mode', async () => {
    const body = (await (await debugApp.request('/boom', json)).json()) as { message: string; exception: { stack: string } };
    expect(body.message).toBe('database password is hunter2');
    expect(body.exception.stack).toContain('kernel.test.ts');
  });

  it('shows no stack for deliberate client errors, even in debug mode', async () => {
    expect(await (await debugApp.request('/forbidden', json)).json()).toEqual({ message: 'Only admins.' });
  });

  it('answers abort() with its status and message, without reporting client errors', async () => {
    entries.length = 0;
    const response = await app.request('/forbidden', json);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: 'Only admins.' });
    expect(entries.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('renders the error page for page requests and navigations', async () => {
    const response = await app.request('/forbidden', page);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-bespoke')).toBe('true');
    expect(await response.json()).toMatchObject({
      component: 'errors/Error',
      props: { status: 403, title: 'Forbidden', message: 'Only admins.', exception: null },
    });
  });

  it('routes unknown paths through the same handler', async () => {
    const response = await app.request('/nope', page);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ component: 'errors/Error', props: { status: 404 } });
  });

  it('generates a request id and writes an access log entry', async () => {
    entries.length = 0;
    const response = await app.request('/nope', json);
    const requestId = response.headers.get('x-request-id');

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entries.at(-1)).toMatchObject({ level: 'info', message: 'GET /nope 404', context: { channel: 'http', requestId } });
  });
});
