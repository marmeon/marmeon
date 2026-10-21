import { createApplication, currentRequest, defineModule, Logger, Redactor, type Application, type Container, type LogContext } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, SharedData, view, type HttpContext, type Next, type PageObject, type SsrRender } from '@marmeon/http';
import { openRoutes } from './test-helpers/open-routes.ts';
import { describe, expect, it } from 'vitest';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel, type KernelOptions } from './kernel.ts';
import { createDocumentRenderer, isBot } from './render.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';

const entries: { level: string; message: string; context: LogContext }[] = [];
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

/** On `/shared-broken`: a shared prop that throws — say, the signed-in user while the database is down. */
class BrokenSharedProps {
  readonly #shared: SharedData;
  constructor(shared: SharedData) {
    this.#shared = shared;
  }
  handle(ctx: HttpContext, next: Next<{}>) {
    if (new URL(ctx.request.url).pathname === '/shared-broken') {
      (this.#shared as unknown as { share(key: string, value: unknown): void }).share('auth', () => {
        throw new Error('the database is down');
      });
    }
    return next();
  }
}

/** An app whose pages render through `render` — a stand-in for an app's SSR entry. */
async function appWith(render: SsrRender, options: KernelOptions = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [
      EncryptionServiceProvider,
      HttpServiceProvider,
      class {
        register(container: Container) {
          container.singleton(Logger, () => new MemoryLogger());
        }
        // What the session package does at boot: the session cookie's name joins the app's Redactor.
        boot(app: Application) {
          app.container.make(Redactor).addKeys('marmeon_session');
        }
      },
    ],
    middleware: { web: [BrokenSharedProps] },
    modules: [
      defineModule({
        name: 'pages',
        routes: openRoutes((Route) => {
          Route.get('/profile', () => view('users/Show', { name: 'Ada', lastLoginAt: new Date('2026-10-01T12:00:00.600Z') }));
          Route.get('/broken', () => {
            throw new Error('the controller failed');
          });
          Route.get('/shared-broken', () => view('users/Show', { name: 'Ada' }));
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey() } });
  const renderer = createDocumentRenderer({ template: () => FALLBACK_TEMPLATE, ssr: () => render });
  return createHttpKernel(application, { renderer, ...options });
}

const page = (html: string) => JSON.parse(/<script type="application\/json" id="marmeon-page">(.*?)<\/script>/.exec(html)![1]!) as PageObject;
const markup = (html: string) => /<div id="app">([\s\S]*)<\/div>/.exec(html)![1];

describe('server rendering gets the page as the browser does', () => {
  it('serializes once: the SSR entry sees a Date as its ISO string — the same value the page script carries', async () => {
    const seen: PageObject[] = [];
    const app = await appWith(async (page) => {
      seen.push(page);
      return { html: `<p>${String(page.props.lastLoginAt)}</p>` };
    });
    const html = await (await app.request('/profile', { headers: { accept: 'text/html' } })).text();

    expect(seen[0]!.props.lastLoginAt).toBe('2026-10-01T12:00:00.600Z');
    expect(page(html).props.lastLoginAt).toBe('2026-10-01T12:00:00.600Z');
    // What the server rendered is what the browser renders from the script: the markup hydrates.
    expect(markup(html)).toBe('<p>2026-10-01T12:00:00.600Z</p>');
  });
});

describe('client fallback: server rendering never breaks a page', () => {
  it('sends the page without markup when SSR throws — the browser renders it — and logs the error', async () => {
    entries.length = 0;
    const app = await appWith(async () => {
      throw new ReferenceError('window is not defined');
    });
    const response = await app.request('/profile', { headers: { accept: 'text/html', 'x-request-id': 'ssr-1' } });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(markup(html)).toBe('');
    expect(page(html)).toMatchObject({ component: 'users/Show', props: { name: 'Ada' } });
    expect(html).not.toContain('Server Error');
    expect(entries).toContainEqual({
      level: 'error',
      message: 'Server rendering of [users/Show] failed — the browser renders the page',
      context: expect.objectContaining({ channel: 'ssr', component: 'users/Show', exception: 'ReferenceError', message: 'window is not defined', requestId: 'ssr-1' }),
    });
  });

  it("logs the failure masked by the app's Redactor: the session cookie an SSR error quotes stays out of the log", async () => {
    entries.length = 0;
    const app = await appWith(async () => {
      throw new Error('the renderer refused Cookie: a=1; marmeon_session=s3ss10nvalue');
    });
    expect((await app.request('/profile', { headers: { accept: 'text/html' } })).status).toBe(200);
    const logged = JSON.stringify(entries);
    expect(logged, `the session id reached the log: ${logged}`).not.toContain('s3ss10nvalue');
    expect(entries).toContainEqual({
      level: 'error',
      message: 'Server rendering of [users/Show] failed — the browser renders the page',
      context: expect.objectContaining({ message: 'the renderer refused Cookie: [redacted]; marmeon_session=[redacted]' }),
    });
  });

  it('falls back for the error page too: a failing controller still gets its error page (rendered by the browser)', async () => {
    const app = await appWith(async () => {
      throw new Error('the layout fails on the server');
    });
    const response = await app.request('/broken', { headers: { accept: 'text/html' } });
    const html = await response.text();
    expect(response.status).toBe(500);
    expect(page(html)).toMatchObject({ component: 'errors/Error', props: { status: 500 } });
  });

  it('builds the error page without shared props when they are what fails — instead of a bare "Server Error"', async () => {
    const app = await appWith(async (page) => ({ html: `<h1>${String(page.props.title)}</h1>` }));
    const response = await app.request('/shared-broken', { headers: { accept: 'text/html' } });
    const html = await response.text();
    expect(response.status).toBe(500);
    expect(page(html)).toMatchObject({ component: 'errors/Error', props: { status: 500, title: 'Server Error' } });
    expect(markup(html)).toBe('<h1>Server Error</h1>');
  });

  it('renders nothing on the server with SERVER_SSR_ENABLED=false (ssr: false) — every page goes out for the browser to render', async () => {
    let calls = 0;
    const app = await appWith(
      async () => {
        calls++;
        return { html: '<p>server</p>' };
      },
      { ssr: false },
    );
    const html = await (await app.request('/profile', { headers: { accept: 'text/html' } })).text();
    expect(calls).toBe(0);
    expect(markup(html)).toBe('');
    expect(page(html).component).toBe('users/Show');
  });
});

describe('streaming', () => {
  const encoder = new TextEncoder();

  it('streams the document: head and shell at once, the rest as it renders — headers as for any page', async () => {
    let finish!: () => void;
    const app = await appWith(async () => ({
      head: '<title>Ada</title>',
      html: new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode('<main>shell'));
          await new Promise<void>((resolve) => (finish = resolve));
          controller.enqueue(encoder.encode('<b>late</b></main>'));
          controller.close();
        },
      }),
    }));
    const response = await app.request('/profile', { headers: { accept: 'text/html' } });
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('vary')).toContain('x-marmeon');

    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let received = '';
    while (!received.includes('<main>shell')) received += (await reader.read()).value;
    // The head (with the page object) and the shell are out before the slow part has rendered.
    expect(received).toContain('<title>Ada</title>');
    expect(received).toContain('id="marmeon-page"');
    expect(received).not.toContain('late');
    finish();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) received += chunk.value;
    expect(received).toMatch(/<div id="app"><main>shell<b>late<\/b><\/main><\/div><\/body>\n<\/html>$/);
  });

  it('logs an error after the shell (the browser renders that part) — the page is already on its way', async () => {
    entries.length = 0;
    const app = await appWith(async (_page, options) => {
      setTimeout(() => options?.onError?.(new Error('a boundary failed')), 5);
      return { html: '<main>shell</main>' };
    });
    expect((await app.request('/profile', { headers: { accept: 'text/html' } })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entries.map((entry) => entry.message)).toContain('Server rendering of [users/Show] failed in a Suspense boundary — the browser renders that part');
  });

  it('stops rendering when the client goes away — the SSR entry sees its signal abort', async () => {
    let signal: AbortSignal | undefined;
    const app = await appWith(async (_page, options) => {
      signal = options?.signal;
      return { html: new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(encoder.encode('<main>')) }) };
    });
    const response = await app.request('/profile', { headers: { accept: 'text/html' } });
    expect(signal?.aborted).toBe(false);
    await response.body!.cancel('gone');
    expect(signal?.aborted).toBe(true);
  });

  it('gives bots the whole page at once (complete), browsers the stream', async () => {
    const complete: (boolean | undefined)[] = [];
    const app = await appWith(async (_page, options) => {
      complete.push(options?.complete);
      return { html: '' };
    });
    await app.request('/profile', { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } });
    await app.request('/profile', { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' } });
    expect(complete).toEqual([true, false]);
  });

  it('leaves client-side visits alone: the page object as JSON, nothing rendered or streamed', async () => {
    let calls = 0;
    const app = await appWith(async () => {
      calls++;
      return { html: '' };
    });
    const response = await app.request('/profile', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(((await response.json()) as PageObject).props).toEqual({ name: 'Ada', lastLoginAt: '2026-10-01T12:00:00.600Z' });
    expect(calls).toBe(0);
  });
});

describe('isBot', () => {
  it('knows crawlers and link previews — not browsers', () => {
    const ua = (agent: string) => new Request('http://localhost/', { headers: { 'user-agent': agent } });
    for (const bot of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'Twitterbot/1.0', 'WhatsApp/2.23']) {
      expect(isBot(ua(bot)), bot).toBe(true);
    }
    for (const browser of ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148']) {
      expect(isBot(ua(browser)), browser).toBe(false);
    }
  });
});
