import { getRequestListener } from '@hono/node-server';
import { createApplication, ErrorSolutions, Logger, type Container, type LogContext } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { ExceptionHandler, HttpServiceProvider, Router } from '@marmeon/http';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import type { HttpContext, Next } from '@marmeon/router';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';
import { islandRoute } from './test-helpers/island-route.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

// Installs the adapter's global Response, as startServer does: a clone is then one of the platform, like what fetch() gives.
getRequestListener(() => new Response());

const errors: { message: string; context: LogContext }[] = [];
class MemoryLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(message: string, context: LogContext = {}): void {
    errors.push({ message, context });
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

let upstream: Server;
let upstreamUrl: string;
beforeAll(async () => {
  upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'upstream=1' });
    response.end('UPSTREAM');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

/** What a handler returns for the failures of the routes below: a Response of fetch(), which an app must not pass on. */
const fetched = () => fetch(upstreamUrl);
class Mine extends Response {}
const REFUSED = /must not pass on/;

async function app(render: () => unknown = () => Response.json({ rendered: true }, { status: 503 })) {
  const fail = () => {
    throw new Error('failed');
  };
  const application = await createApplication({ root: import.meta.dirname, discover: false, providers: [LoggingProvider, EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider] }, {
    env: { APP_KEY: generateKey(), NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    override: (container) => {
      container.instance(ExceptionHandler, { render: () => render() });
      container.instance(ErrorSolutions, { find: async () => [{ title: 'SOLUTION', text: 'Text.' }] } as unknown as ErrorSolutions);
      container.make(Router).load(openRoutes((Route) => {
        Route.get('/constant', () => new Response('own', { status: 403 }));
        Route.get('/subclass', () => new Mine('own', { status: 401 }));
        Route.get('/clone', () => new Response('own', { status: 503 }).clone());
        Route.get('/json', () => Response.json({ own: true }, { status: 202 }));
        Route.get('/redirect', () => Response.redirect('http://localhost/json', 301));
        Route.get('/manual', () => new Response(null, { status: 302, headers: { location: '/json' } }));
        Route.get('/no-content', () => new Response(null, { status: 204 }));
        Route.get('/not-modified', () => new Response(null, { status: 304 }));
        Route.get('/fetched', fetched);
        Route.get('/fetched-clone', async () => (await fetched()).clone());
        Route.get('/error', () => Response.error());
        Route.get('/used', async () => {
          const used = new Response('own');
          await used.text();
          return used;
        });
        Route.get('/cancelled', async () => {
          const cancelled = new Response('own');
          await cancelled.body!.cancel();
          return cancelled;
        });
        Route.get('/locked', () => {
          const locked = new Response('own');
          locked.body!.getReader();
          return locked;
        });
        Route.get('/plain-object', () => ({ status: 418, headers: {}, body: 'not a response' }));
        Route.get('/fails', fail);
        Route.get('/islands/fails', islandRoute(fail));
      }));
    },
  });
  onTestFinished(() => application.shutdown());
  return createHttpKernel(application, { debug: true });
}

describe('a route returns a Response', () => {
  it.each([
    ['a constant', '/constant', 403, 'own'],
    ['a subclass', '/subclass', 401, 'own'],
    ['a clone of an own one', '/clone', 503, 'own'],
    ['Response.json()', '/json', 202, '{"own":true}'],
    ['Response.redirect()', '/redirect', 301, ''],
    ['a manual redirect', '/manual', 302, ''],
    ['a 204', '/no-content', 204, ''],
    ['a 304', '/not-modified', 304, ''],
  ] as const)('%s: it goes out as it is', async (_name, path, status, body) => {
    const response = await (await app()).request(path);
    expect([response.status, await response.text()]).toEqual([status, body]);
  });

  it.each([
    ['of fetch()', '/fetched'],
    ['a clone of one', '/fetched-clone'],
    ['Response.error()', '/error'],
    ['one whose body is used', '/used'],
    ['one whose body was cancelled', '/cancelled'],
    ['one whose body is locked', '/locked'],
  ] as const)('%s: it is refused with a 500 and says why in the log', async (_name, path) => {
    errors.length = 0;
    const kernel = await app(() => Response.json({ failed: true }, { status: 500 }));
    const response = await kernel.request(path);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ failed: true, solution: { title: 'SOLUTION', text: 'Text.' } });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(JSON.stringify(errors)).toMatch(REFUSED);
  });

  it('a plain object stays data', async () => {
    const response = await (await app()).request('/plain-object');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 418, headers: {}, body: 'not a response' });
  });
});

describe('the development JSON error', () => {
  it('adds the solution to an error the handler rendered itself, and re-serialises it whole', async () => {
    const kernel = await app(() => new Response(JSON.stringify({ rendered: true }), { status: 503, headers: { 'content-type': 'application/json', 'content-length': '999', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked' } }));
    const response = await kernel.request('/fails', { headers: { host: 'localhost', accept: 'application/json' } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ rendered: true, solution: { title: 'SOLUTION', text: 'Text.' } });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('transfer-encoding')).toBeNull();
  });

  it('refuses a Response of fetch() the handler rendered, and says so in the log', async () => {
    errors.length = 0;
    const held = await fetched();
    const response = await (await app(() => held)).request('/fails', { headers: { host: 'localhost', accept: 'application/json' } });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Server Error');
    expect(errors.map((entry) => entry.message)).toContain('Rendering the development error page failed');
    expect(JSON.stringify(errors)).toMatch(REFUSED);
  });
});

describe("an island's error", () => {
  const headers = { accept: 'application/json', 'x-marmeon-region': 'island', [PAGE_HEADER]: PROTOCOL_VERSION };

  it('answers a Response the handler rendered itself', async () => {
    const response = await (await app(() => Response.json({ own: true }, { status: 409 }))).request('/islands/fails', { headers });
    expect([response.status, await response.json()]).toEqual([409, { own: true }]);
  });

  it('refuses a Response of fetch() the handler rendered: the generic error, and the log says why', async () => {
    errors.length = 0;
    const held = await fetched();
    const response = await (await app(() => held)).request('/islands/fails', { headers });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: 'Server Error' });
    expect(errors.map((entry) => entry.message)).toContain('Rendering the error of an island failed');
    expect(JSON.stringify(errors)).toMatch(REFUSED);
  });
});

describe('HEAD after a GET that read the body of a Response a module made once', () => {
  it('answers 403 to the HEAD', async () => {
    // The platform's own class, so the constant is native whatever the adapter did to the global.
    let Platform: typeof Response = Response;
    while (Object.getPrototypeOf(Platform) !== Function.prototype) Platform = Object.getPrototypeOf(Platform);
    const gate = new Platform('no', { status: 403 });
    class Refuses {
      async handle(_ctx: HttpContext, next: Next<{}>) {
        await next();
        return gate;
      }
    }
    const application = await createApplication({ root: import.meta.dirname, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider] }, {
      env: { APP_KEY: generateKey(), NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      override: (container) => container.make(Router).load(openRoutes((Route) => Route.middleware(Refuses).get('/gate', () => 'x'))),
    });
    onTestFinished(() => application.shutdown());
    const kernel = createHttpKernel(application);
    const got = await kernel.request('/gate');
    expect(await got.text()).toBe('no');
    expect((await kernel.request('/gate', { method: 'HEAD' })).status).toBe(403);
  });
});
