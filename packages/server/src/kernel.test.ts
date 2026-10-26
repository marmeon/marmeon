import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { ConsoleLogger, createApplication, currentRequest, defineModule, Logger, Redactor, type Container, type LogContext } from '@marmeon/core';
import { abort, AfterResponse, Controller, HttpServiceProvider, SharedData, view, type HttpContext, type Next } from '@marmeon/http';
import { LOCATION_HEADER, PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { UPLOAD_HEADER } from '@marmeon/http/protocol';
import { openRoutes } from './test-helpers/open-routes.ts';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { ServerConfig, ServerServiceProvider } from './provider.ts';

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
    providers: [EncryptionServiceProvider, HttpServiceProvider, RequestScopeProvider],
    modules: [defineModule({ name: 'ids', routes: openRoutes((Route) => Route.get('/id', ShowRequestIdController)) })],
  }, { env: { APP_KEY: generateKey() } });
  const app = createHttpKernel(application);

  it('resolves controllers from a fresh scope per request', async () => {
    type Ids = { first: number; second: number };
    const one = (await (await app.request('/id')).json()) as Ids;
    const two = (await (await app.request('/id')).json()) as Ids;

    expect(one.first).toBe(one.second); // same instance within a request
    expect(two.first).not.toBe(one.first); // new instance for the next request
  });

  it('answers request() and fetch() alike, and offers no Hono method', async () => {
    const byPath = await app.request('/id');
    const byRequest = await app.fetch(new Request('http://localhost/id'));
    expect(byPath.status).toBe(byRequest.status);
    expect(byPath.headers.get('content-type')).toBe(byRequest.headers.get('content-type'));
    expect((await app.request(new URL('http://localhost/id'))).status).toBe(200);
    expect((await app.request('id')).status).toBe(200); // relative paths are against http://localhost
    // @ts-expect-error Hono's `route` is not part of the kernel
    expect(app.route).toBeUndefined();
  });
});

describe('createHttpKernel — what a caller cannot hand in', async () => {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    modules: [defineModule({ name: 'whoami', routes: openRoutes((Route) => Route.get('/whoami', (ctx) => ({ ip: ctx.ip ?? null }))) })],
  }, { env: { APP_KEY: generateKey() } });
  const app = createHttpKernel(application);
  const headers = { accept: 'application/json' };

  it('answers a Hono env as an ordinary request without a peer: no island parent, no socket address', async () => {
    const forgedParent = { parent: { request: new Request('http://localhost/'), scope: application.container, requestId: 'forged' } } as never;
    const forgedSocket = { incoming: { socket: { remoteAddress: '203.0.113.9' } } } as never;
    const first = await app.fetch(new Request('http://localhost/whoami', { headers }), forgedParent);
    const second = await app.request('/whoami', { headers }, forgedSocket);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await first.json()).toEqual({ ip: null });
    expect(await second.json()).toEqual({ ip: null });
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

  // A cookie header quoted by an error: the session cookie after another one. The core's key list masks `Cookie: a=1` up to
  // the first `;` — only the name the session package adds to the app's Redactor masks the session id behind it.
  const LEAKY_COOKIE = 'Cookie: a=1; marmeon_session=s3ss10nvalue';
  class CookieDeferringController {
    readonly #after: AfterResponse;
    constructor(after: AfterResponse) {
      this.#after = after;
    }
    handle() {
      this.#after.defer(() => {
        throw new Error(`deferred work refused ${LEAKY_COOKIE}`);
      });
      return 'accepted';
    }
  }
  class CookieTerminating {
    handle(_ctx: HttpContext, next: Next<{}>) {
      return next();
    }
    terminate(ctx: HttpContext): void {
      if (new URL(ctx.request.url).pathname === '/cookie-defer') throw new Error(`a terminate hook refused ${LEAKY_COOKIE}`);
    }
  }
  const routes = openRoutes((Route) => {
    Route.get('/boom', () => {
      throw new Error('database password is hunter2 (postgres://app:hunter3@db/app)');
    });
    Route.get('/forbidden', () => abort(403, 'Only admins.'));
    Route.get('/vary-own', () => view('errors/Error', { status: 200, title: 'a', message: 'b', exception: null }, { headers: { Vary: 'Accept, X-Marmeon, Origin' } }));
    Route.get('/vary-star', () => view('errors/Error', { status: 200, title: 'a', message: 'b', exception: null }, { headers: { vary: '*' } }));
    Route.get('/cookie-boom', () => {
      throw new Error(`the upstream refused the request with ${LEAKY_COOKIE}`);
    });
    Route.get('/cookie-defer', CookieDeferringController);
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, LoggingProvider],
    middleware: { web: [CookieTerminating] },
    modules: [defineModule({ name: 'errors', routes })],
  }, { env: { APP_KEY: generateKey() } });
  // What the session package does at boot: the session cookie's name joins the app's Redactor.
  application.container.make(Redactor).addKeys('marmeon_session');
  const app = createHttpKernel(application);
  const debugApp = createHttpKernel(application, { debug: true });
  const json = { headers: { accept: 'application/json' } };
  const page = { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } };

  it('hides unexpected errors from clients, but reports them with the request id', async () => {
    entries.length = 0;
    const response = await app.request('/boom', { headers: { ...json.headers, 'x-request-id': 'req-1' } });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: 'Server Error' });
    expect(response.headers.get('x-request-id')).toBe('req-1');
    // The log line's own text is masked like text: the URL's password goes, free prose stays (redactText is a net).
    expect(JSON.stringify(entries), 'the report logged a URL password in clear').not.toContain('hunter3');
    expect(entries.find((entry) => entry.level === 'error')).toMatchObject({
      message: 'database password is hunter2 (postgres://app:***@db/app)',
      context: { requestId: 'req-1', exception: 'Error' },
    });
  });

  it("masks with the app's Redactor: the session cookie a reported error, a terminate hook or deferred work quotes stays out of the log", async () => {
    entries.length = 0;
    await app.settle();
    expect((await app.request('/cookie-boom', json)).status).toBe(500);
    expect((await app.request('/cookie-defer', json)).status).toBe(200);
    await app.settle();
    const logged = JSON.stringify(entries);
    expect(logged, `the session id reached the log: ${logged}`).not.toContain('s3ss10nvalue');
    expect(entries.filter((entry) => entry.level === 'error').map((entry) => entry.message)).toEqual(
      expect.arrayContaining(['the upstream refused the request with Cookie: [redacted]; marmeon_session=[redacted]', 'A terminate hook failed', 'Deferred work failed']),
    );
    expect(entries.find((entry) => entry.message === 'A terminate hook failed')?.context.exception).toBe(
      'Error: a terminate hook refused Cookie: [redacted]; marmeon_session=[redacted]',
    );
  });

  it('shows exception details in debug mode', async () => {
    const body = (await (await debugApp.request('/boom', json)).json()) as { message: string; exception: { stack: string } };
    expect(body.message).toBe('database password is hunter2 (postgres://app:hunter3@db/app)');
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
    expect(response.headers.get(PAGE_HEADER)).toBe(PROTOCOL_VERSION);
    expect(await response.json()).toMatchObject({
      component: 'errors/Error',
      props: { status: 403, title: 'Forbidden', message: 'Only admins.', exception: null },
    });
  });

  it('lists Accept and every page header in Vary on an error page, once each', async () => {
    const vary = (await app.request('/forbidden', page)).headers.get('vary')!.split(',').map((name) => name.trim().toLowerCase());
    expect(vary).toContain('accept');
    expect(vary).toContain('x-marmeon');
    expect(new Set(vary).size).toBe(vary.length);
  });

  it('keeps the Vary a view result brings, adds the page headers and no duplicates', async () => {
    const vary = (await app.request('/vary-own', page)).headers.get('vary')!.split(',').map((name) => name.trim().toLowerCase());
    expect(vary).toEqual(expect.arrayContaining(['accept', 'origin', 'x-marmeon', 'x-marmeon-region', 'x-marmeon-once-scope']));
    expect(new Set(vary).size).toBe(vary.length);
    expect((await app.request('/vary-star', page)).headers.get('vary')).toBe('*');
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

/**
 * The request line: built only when the logger lets `info` through — with `LOG_LEVEL=silent` neither the message nor its
 * redacted path is computed. The counter sits on the Redactor's `path`, the expensive half of the line.
 */
describe('createHttpKernel — the request line at a level that discards it', async () => {
  const written: string[] = [];
  let level: 'info' | 'silent' = 'info';
  const logger: Logger = {
    debug: () => undefined,
    info: (message) => void (level === 'info' && written.push(message)), // a logger writes what its level lets through
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    enabled: (asked) => level === 'info' && asked !== 'debug',
  };
  class SilentLoggingProvider {
    register(container: Container) {
      container.singleton(Logger, () => logger);
    }
  }
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SilentLoggingProvider],
    modules: [defineModule({ name: 'users', routes: openRoutes((Route) => Route.get('/users/:id', () => ({ ok: true }))) })],
  }, { env: { APP_KEY: generateKey() } });
  const redactor = application.container.make(Redactor);
  let built = 0;
  const path = redactor.path.bind(redactor);
  redactor.path = (...args: Parameters<Redactor['path']>) => {
    built++;
    return path(...args);
  };
  const app = createHttpKernel(application);

  it('builds no request line (and redacts no path) when info is off', async () => {
    level = 'silent';
    built = 0;
    written.length = 0;
    expect((await app.request('/users/7')).status).toBe(200);
    expect(built, 'the request line was built at LOG_LEVEL=silent').toBe(0);
    expect(written).toEqual([]);
  });

  it('writes it — redacted once — when info is on', async () => {
    level = 'info';
    built = 0;
    written.length = 0;
    expect((await app.request('/users/7')).status).toBe(200);
    expect(written).toEqual(['GET /users/7 200']);
    expect(built).toBe(1);
  });
});

describe('createHttpKernel — requests & responses', async () => {
  class SaveDraftController extends Controller {
    async handle(ctx: HttpContext) {
      const { title } = await ctx.input();
      ctx.cookies.set('draft', String(title));
      if (title === 'boom') abort(422, 'Not like this.');
      return this.redirect().route('drafts.show', { id: 7 });
    }
  }

  const routes = openRoutes((Route) => {
    Route.get('/drafts/:id', (ctx) => ({ id: ctx.params.id })).name('drafts.show');
    Route.post('/drafts', SaveDraftController);
    Route.put('/drafts/:id', (ctx) => ctx.input());
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    modules: [defineModule({ name: 'drafts', routes })],
  }, { env: { APP_KEY: generateKey(), SERVER_MAX_BODY_MB: '1' } });
  const app = createHttpKernel(application);
  const form = (fields: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(fields) });

  it('resolves named-route redirects through the router, with 303 after a POST', async () => {
    const response = await app.request('/drafts', form({ title: 'Hello' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/drafts/7');
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^draft=[\w-]+; Path=\/; HttpOnly; SameSite=Lax$/)]); // encrypted (web group)
  });

  describe('a redirect to another origin', () => {
    class LeaveController extends Controller {
      handle(ctx: HttpContext) {
        const params = new URL(ctx.request.url).searchParams;
        if (!ctx.request.headers.has(UPLOAD_HEADER)) ctx.cookies.set('seen', '1'); // an upload request is read-only
        const target = this.redirect(params.get('to') ?? '/');
        return params.has('status') ? target.status(Number(params.get('status')) as 307) : target;
      }
    }
    const leaving = openRoutes((Route) => {
      Route.post('/leave', LeaveController);
      Route.get('/leave', LeaveController);
    });
    const leavingKernel = (async () => {
      const application = await createApplication({
        root: import.meta.dirname,
        discover: false,
        providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
        modules: [defineModule({ name: 'leaving', routes: leaving })],
      }, { env: { APP_KEY: generateKey() } });
      return createHttpKernel(application);
    })();
    const post = async (to: string, headers: Record<string, string> = {}, extra = '') =>
      (await leavingKernel).request(`/leave?to=${encodeURIComponent(to)}${extra}`, { method: 'POST', body: new URLSearchParams({ a: '1' }), headers });
    const visit = { [PAGE_HEADER]: PROTOCOL_VERSION };

    it.each(['https://other.example/x', '//other.example/x', 'http://localhost.evil.example/'])('%s: a page request gets 409 and x-marmeon-location, no Location', async (to) => {
      const response = await post(to, visit);
      expect(response.status).toBe(409);
      expect(response.headers.get(LOCATION_HEADER)).toBe(new URL(to, 'http://localhost/').href);
      expect(response.headers.get('location')).toBeNull();
    });

    it('also converts the redirect of an upload target request, and of a GET visit, 307 and 308, another port or scheme', async () => {
      const upload = await post('https://other.example/x', { ...visit, [UPLOAD_HEADER]: 'avatar' });
      expect([upload.status, upload.headers.get(LOCATION_HEADER), upload.headers.get('location')]).toEqual([409, 'https://other.example/x', null]);
      for (const status of ['307', '308']) expect((await post('https://other.example/', visit, `&status=${status}`)).status).toBe(409);
      for (const to of ['http://localhost:8080/', 'https://localhost/']) expect((await post(to, visit)).headers.get(LOCATION_HEADER)).toBe(to);
      const get = await (await leavingKernel).request(`/leave?to=${encodeURIComponent('https://other.example/')}`, { headers: visit });
      expect([get.status, get.headers.get('location')]).toEqual([409, null]);
    });

    it('the 409 is never cached, varies on the request kind and keeps the cookies', async () => {
      const response = await post('https://other.example/x', visit);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')?.toLowerCase()).toContain(PAGE_HEADER);
      expect(response.headers.get('vary')?.toLowerCase()).toContain(UPLOAD_HEADER);
      expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^seen=/)]);
    });

    it('keeps a same-origin redirect of a page request as it is', async () => {
      for (const to of ['/home', 'http://localhost/home']) {
        const response = await post(to, visit);
        expect([response.status, response.headers.get('location'), response.headers.get(LOCATION_HEADER)]).toEqual([303, to, null]);
      }
    });

    it('keeps the redirect of a full browser request, foreign or not', async () => {
      const response = await post('https://other.example/x');
      expect([response.status, response.headers.get('location')]).toEqual([303, 'https://other.example/x']);
    });
  });

  it('adds queued cookies to error responses too', async () => {
    const response = await app.request('/drafts', { ...form({ title: 'boom' }), headers: { accept: 'application/json' } });
    expect(response.status).toBe(422);
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^draft=[\w-]+; Path=\/; HttpOnly; SameSite=Lax$/)]);
  });

  it('enforces the body limit from the server config (SERVER_MAX_BODY_MB)', async () => {
    expect(application.container.make(ServerConfig).maxBodyBytes).toBe(1024 ** 2);
    const put = (text: string) =>
      app.request('/drafts/1', {
        method: 'PUT',
        body: JSON.stringify({ text }),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      });
    const wrapper = JSON.stringify({ text: '' }).length;
    expect((await put('x'.repeat(1024 ** 2 - wrapper))).status).toBe(200);
    const response = await put('x'.repeat(1024 ** 2 - wrapper + 1));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ message: 'The request body exceeds 1048576 bytes.' });
  });

  it('takes a limit under 1 MB from createHttpKernel({ maxBodyBytes }), which wins over the config', async () => {
    const small = createHttpKernel(application, { maxBodyBytes: 1024 });
    const response = await small.request('/drafts/1', {
      method: 'PUT',
      body: JSON.stringify({ text: 'x'.repeat(2000) }),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ message: 'The request body exceeds 1024 bytes.' });
  });

  it('refuses to boot the web group without an Encrypter — at boot, not on the first request', async () => {
    await expect(
      createApplication({ root: import.meta.dirname, discover: false, providers: [HttpServiceProvider] }, { env: {} }),
    ).rejects.toThrow('The web middleware group needs the Encrypter');
  });

  it.each(['8m', 'lots', '1.5', '0', '-1', '1048576'])('rejects SERVER_MAX_BODY_MB=%s at boot', async (value) => {
    await expect(
      createApplication({ root: import.meta.dirname, discover: false, providers: [ServerServiceProvider] }, { env: { SERVER_MAX_BODY_MB: value } }),
    ).rejects.toThrow(/server: SERVER_MAX_BODY_MB — Expected (a whole number of MB|at least 1 MB|at most 1024 MB)/);
  });
});

describe('createHttpKernel — the default body limit', async () => {
  const routes = openRoutes((Route) => {
    Route.put('/drafts/:id', (ctx) => ctx.input());
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    modules: [defineModule({ name: 'drafts', routes })],
  }, { env: { APP_KEY: generateKey() } });
  const app = createHttpKernel(application);
  const put = (bytes: number) =>
    app.request('/drafts/1', {
      method: 'PUT',
      body: JSON.stringify({ text: 'x'.repeat(bytes - JSON.stringify({ text: '' }).length) }),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });

  it('is 8 MiB: a body of exactly that passes, one byte more is a 413', async () => {
    expect(application.container.make(ServerConfig).maxBodyBytes).toBe(8 * 1024 ** 2);
    expect((await put(8 * 1024 ** 2)).status).toBe(200);
    expect((await put(8 * 1024 ** 2 + 1)).status).toBe(413);
  });
});

describe('createHttpKernel — middleware groups & terminate', async () => {
  const events: string[] = [];
  const logged: string[] = [];
  class CapturingLogger extends ConsoleLogger {
    override error(message: string, context?: LogContext) {
      logged.push(`${message}: ${String(context?.exception)}`);
    }
    override child(): Logger {
      return this;
    }
  }
  class CaptureLogs {
    register(container: Container) {
      container.singleton(Logger, () => new CapturingLogger());
    }
  }
  class Stamp {
    async handle(_ctx: HttpContext, next: Next<{}>) {
      const response = await next();
      const stamped = new Response(response.body, response);
      stamped.headers.set('x-stamp', 'global');
      return stamped;
    }
    async terminate(_ctx: HttpContext, response: Response) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`terminated ${response.status}`);
    }
  }
  class Failing {
    handle(_ctx: HttpContext, next: Next<{}>) {
      return next();
    }
    terminate(): void {
      throw new Error('terminate broke at postgres://app:s3cretPW@db/app token=abc123');
    }
  }
  class DeferringController {
    readonly #after: AfterResponse;
    constructor(after: AfterResponse) {
      this.#after = after;
    }
    handle() {
      this.#after.defer(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('deferred work');
      });
      this.#after.defer(() => {
        throw new Error('deferred broke at postgres://app:s3cretPW@db/app');
      });
      this.#after.defer(() => events.push('after the failure'));
      return 'accepted';
    }
  }
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, CaptureLogs],
    middleware: { global: [Stamp], api: [Failing] },
    modules: [
      defineModule({
        name: 'groups',
        routes: openRoutes((Route) => {
          Route.get('/page', () => 'page');
          Route.get('/admin', () => abort(403));
          Route.get('/defer', DeferringController);
        }),
        apiRoutes: openRoutes((Route) => Route.get('/items', () => [])),
      }),
    ],
  }, { env: { APP_KEY: generateKey() } });
  const app = createHttpKernel(application);

  it('runs global middleware for routes of every group and for unknown paths', async () => {
    for (const path of ['/page', '/api/items', '/nope']) {
      expect((await app.request(path)).headers.get('x-stamp')).toBe('global');
    }
  });

  it('turns errors into responses inside the pipeline, so outer middleware still applies to them', async () => {
    const response = await app.request('/admin', { headers: { accept: 'application/json' } });
    expect(response.status).toBe(403);
    expect(response.headers.get('x-stamp')).toBe('global');
  });

  it('runs terminate hooks after the response — and settle() waits for them', async () => {
    await app.settle(); // hooks of earlier tests
    events.length = 0;
    const response = await app.request('/page');
    events.push(`responded ${response.status}`);
    await app.settle();
    expect(events).toEqual(['responded 200', 'terminated 200']);
  });

  it('runs afterResponse.defer() work after the response — in order, a failure logged, settle() waits', async () => {
    await app.settle();
    events.length = 0;
    const response = await app.request('/defer');
    // The 20 ms of work did not hold the response: it answered before the work ran (the order below) — no time window.
    events.push(`responded ${response.status}`);
    await app.settle();
    expect(events.filter((event) => !event.startsWith('terminated'))).toEqual(['responded 200', 'deferred work', 'after the failure']);
    expect(logged.some((line) => line.startsWith('Deferred work failed: Error: deferred broke at postgres://app:***@db/app'))).toBe(true);
    expect(logged.join('\n'), 'a deferred failure logged its message in clear').not.toContain('s3cretPW');
  });

  it('logs a failing terminate hook instead of breaking anything', async () => {
    const response = await app.request('/api/items');
    await app.settle();
    expect(response.status).toBe(200);
    // Masked like text: the context's keys alone never catch what an error's message quotes.
    expect(logged.join('\n'), 'a terminate hook\'s failure logged its message in clear').not.toContain('s3cretPW');
    expect(logged).toContain('A terminate hook failed: Error: terminate broke at postgres://app:***@db/app token=[redacted]');
  });
});

describe('createHttpKernel — shared props', async () => {
  class ShareTheme {
    constructor(shared: SharedData) {
      this.#shared = shared;
    }
    readonly #shared: SharedData;
    handle(_ctx: HttpContext, next: Next<{}>) {
      (this.#shared as unknown as { share(key: string, value: unknown): void }).share('theme', 'dark');
      (this.#shared as unknown as { share(key: string, value: unknown): void }).share('title', 'shared');
      return next();
    }
  }
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    middleware: { web: [ShareTheme] },
    modules: [defineModule({ name: 'pages', routes: openRoutes((Route) => Route.get('/page', () => view('pages/Show', { title: 'own' }))) })],
  }, { env: { APP_KEY: generateKey() } });
  const app = createHttpKernel(application, { debug: true });

  it('merges shared props into every page — a prop of the controller wins', async () => {
    const page = (await (await app.request('/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } })).json()) as { props: unknown };
    expect(page.props).toEqual({ theme: 'dark', title: 'own' });
  });
});

describe('createHttpKernel — asset versioning', async () => {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [
      defineModule({
        name: 'pages',
        routes: openRoutes((Route) => {
          Route.get('/page', () => view('pages/Show', {}));
          Route.post('/save', () => ({ saved: true }));
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey() } });
  const visit = (app: ReturnType<typeof createHttpKernel>, version?: string, method = 'GET', path = '/page') =>
    app.request(path, { method, headers: { [PAGE_HEADER]: PROTOCOL_VERSION, ...(version ? { 'x-marmeon-version': version } : {}) } });

  it('answers a client-side visit from an older build with 409 and the URL to load fully', async () => {
    const app = createHttpKernel(application, { assetVersion: 'v2' });
    const stale = await visit(app, 'v1');
    expect(stale.status).toBe(409);
    expect(stale.headers.get('x-marmeon-location')).toBe('http://localhost/page');

    const current = await visit(app, 'v2');
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ component: 'pages/Show', version: 'v2' });
  });

  it('never throws away a form submit, and does not check without a version (development)', async () => {
    expect((await visit(createHttpKernel(application, { assetVersion: 'v2' }), 'v1', 'POST', '/save')).status).not.toBe(409);
    expect((await visit(createHttpKernel(application, { assetVersion: 'v2' }))).status).toBe(200); // header missing
    expect((await visit(createHttpKernel(application), 'v1')).status).toBe(200); // no version known
  });
});

describe('createHttpKernel — response copies', async () => {
  /** An app may hand out one Response object to every request — a constant without a body. */
  const SHARED = new Response(null, { status: 204, headers: { 'x-own': 'yes' } });
  let visits = 0;
  class SetVisitCookie {
    async handle(ctx: HttpContext, next: Next<{}>) {
      ctx.cookies.set('visit', String(++visits));
      return next();
    }
  }
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    middleware: { web: [SetVisitCookie] },
    modules: [
      defineModule({
        name: 'pages',
        routes: openRoutes((Route) => {
          Route.get('/shared', () => SHARED);
          Route.get('/page', () => view('pages/Show', {}));
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey() } });
  const app = createHttpKernel(application);

  /** Counts `new Response(body, response)` — a copy of another response — while `run` runs. */
  async function copies(run: () => Promise<unknown>): Promise<number> {
    const Original = globalThis.Response;
    let count = 0;
    // A proxy, not a subclass: `instanceof Response` stays true for responses made before.
    globalThis.Response = new Proxy(Original, {
      construct(target, args: ConstructorParameters<typeof Response>, newTarget) {
        if (args[1] instanceof Original) count++;
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    try {
      await run();
    } finally {
      globalThis.Response = Original;
    }
    return count;
  }

  it('sets the headers of a response it made for the request in place — no copy, also with cookies and the request id', async () => {
    let response: Response | undefined;
    expect(await copies(async () => (response = await app.request('/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } })))).toBe(0);
    expect(response!.headers.get('x-request-id')).toBeTruthy();
    expect(response!.headers.getSetCookie().some((cookie) => cookie.startsWith('visit='))).toBe(true);
  });

  it("copies an app's own response once — a constant handed to every request never carries one request's cookie to the next", async () => {
    const answers: Response[] = [];
    expect(await copies(async () => answers.push(await app.request('/shared')))).toBe(1);
    answers.push(await app.request('/shared'));
    const [first, second] = answers.map((answer) => answer.headers.getSetCookie());
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first![0]).not.toBe(second![0]);
    expect(answers.map((answer) => answer.headers.get('x-own'))).toEqual(['yes', 'yes']);
    // The constant itself is as the app made it.
    expect([...SHARED.headers]).toEqual([['x-own', 'yes']]);
  });
});
