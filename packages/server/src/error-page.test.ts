import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApplication, defineModule, Logger, token, type Application } from '@marmeon/core';
import { channels } from '@marmeon/core/diagnostics';
import { messageBase, publishEnded } from '@marmeon/core/internal';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { abort, Controller, HttpServiceProvider, view, type HttpContext, type Next, type PageObject } from '@marmeon/http';
import { defineMiddleware } from '@marmeon/router';
import { openRoutes } from './test-helpers/open-routes.ts';
import { describe, expect, it } from 'vitest';
import { DevRequestRecorder } from './error-page/recorder-token.ts';
import { createHttpKernel } from './kernel.ts';
import { ServerConfig, ServerServiceProvider } from './provider.ts';
import type { PageRenderer } from './render.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';

interface Mailer {
  send(): void;
}
const Mailer = token<Mailer>('Mailer');

/** The app of the current test — the controllers report queries for it, as the database would. */
let current: Application | undefined;
const query = (sql: string, parameters: unknown[] = [], secret = false) => {
  if (current && channels.tracing('db.query').hasSubscribers) {
    publishEnded(channels.tracing('db.query'), { ...messageBase(current), connection: 'default', driver: 'sqlite', sql, parameters, secret, durationMs: 1.25 });
  }
};

/** Throws from a line the test finds by its text. */
class ExplodingController extends Controller {
  readonly #logger: Logger;
  constructor(logger: Logger) {
    super();
    this.#logger = logger;
  }
  handle() {
    query('select * from users where email = ?', ['ada@example.com']);
    query('update users set password = ? where id = ?', ['$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', 7], true);
    this.#logger.info('Looking at the user', { user: 7, token: 'tok-123' });
    throw new Error('The controller failed on purpose'); // ← the throwing line
  }
}

class SendWelcomeController {
  constructor(_mailer: Mailer) {}
  handle() {
    return { sent: true };
  }
}

/** A global middleware that fails before any route matched, on one path. */
class FailsBeforeRouting {
  handle(ctx: HttpContext, next: Next<{}>) {
    if (new URL(ctx.request.url).pathname.startsWith('/unrouted/')) throw new Error('The middleware failed');
    return next();
  }
}

let release: (() => void) | undefined;
const routes = openRoutes((Route) => {
  Route.middleware(defineMiddleware('AuditTrail', (_ctx, next) => next())).get('/explode/:user', ExplodingController).name('lab.explode');
  Route.get('/invite/:code', () => {
    throw new Error('The invite failed');
  });
  Route.post('/login', async (ctx) => {
    await ctx.input();
    throw new Error('Signing in failed');
  });
  Route.get('/unbound', SendWelcomeController);
  Route.get('/forbidden', () => abort(403, 'Only admins.'));
  Route.get('/home', () => view('Home', {}));
  // Two requests at once: the slow one waits until the other one ran its queries, then fails.
  Route.get('/slow', async () => {
    query('select 1 -- the slow request');
    await new Promise<void>((resolve) => (release = resolve));
    throw new Error('The slow request failed');
  });
  Route.get('/quick', () => {
    query('select 2 -- the quick request');
    release?.();
    return { ok: true };
  });
});

/** Writes nothing — but publishes on the log channel, as the framework's loggers do. */
class Quiet implements Logger {
  debug() {}
  info(message: string, context: Record<string, unknown> = {}) {
    if (current && channels.event('log').hasSubscribers) channels.event('log').publish({ ...messageBase(current), level: 'info', message, context });
  }
  warn() {}
  error(message: string, context?: unknown) { if (process.env.DEBUG_TEST) console.log(message, context); }
  child(): Logger {
    return this;
  }
}

async function boot({ env = { NODE_ENV: 'development' } as Record<string, string>, renderer }: { env?: Record<string, string>; renderer?: PageRenderer } = {}) {
  const application = await createApplication({
    root: fileURLToPath(new URL('../../../', import.meta.url)),
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    middleware: { global: [FailsBeforeRouting] },
    modules: [defineModule({ name: 'lab', routes })],
  }, { env: { APP_KEY: generateKey(), ...env }, override: (container) => container.instance(Logger, new Quiet()) });
  current = application;
  return { application, kernel: createHttpKernel(application, renderer ? { renderer } : {}) };
}

const page = { headers: { accept: 'text/html' } };
const visit = { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, accept: 'text/html, application/json' } };

/** One `<section id>` of the page. */
function sectionOf(html: string, id: string): string {
  return new RegExp(`<section id="${id}">([\\s\\S]*?)</section>`).exec(html)?.[1] ?? '';
}

/** The Markdown of the page (the text field), unescaped. */
function markdownOf(html: string): string {
  const raw = /<textarea id="marmeon-markdown"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? '';
  return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

describe('the development error page', () => {
  it('shows the class, the message, the throwing line of the controller with an editor link, the route, the queries and the log', async () => {
    const { application, kernel } = await boot();
    try {
      const response = await kernel.request('/explode/7', page);
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const html = await response.text();
      // Its own CSP: exactly its inline style and script, by hash — an app's contentSecurityPolicy() leaves it alone.
      const policy = response.headers.get('content-security-policy')!;
      const hashOf = (tag: 'style' | 'script') => `'sha256-${createHash('sha256').update(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)![1]!).digest('base64')}'`;
      expect(policy).toContain(`style-src ${hashOf('style')}`);
      expect(policy).toContain(`script-src ${hashOf('script')}`);
      expect(policy).toMatch(/^default-src 'none'; /);
      expect(html).toContain('<span class="class">Error</span>');
      expect(html).toContain('The controller failed on purpose');

      // The code snippet's current line is the line that threw (Node runs the TypeScript as it is).
      const source = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
      const throwing = source.findIndex((line) => line.includes("throw new Error('The controller failed on purpose')")) + 1;
      const current = /<span class="line current"><span class="number">(\d+)<\/span>(.*?)<\/span>/.exec(html);
      expect(Number(current?.[1])).toBe(throwing);
      expect(current?.[2]).toContain('throw new Error(&#39;The controller failed on purpose&#39;)');
      expect(html).toContain(`/__open-in-editor?file=${encodeURIComponent(`${fileURLToPath(import.meta.url)}:${throwing}:`)}`);
      expect(html).toContain('target="marmeon-editor"');

      // Route, queries (the secret statement without its parameters), the log line (its token redacted).
      expect(html).toContain('<code>lab.explode</code>');
      expect(html).toContain('ExplodingController');
      // A defineMiddleware() by its name, as route:list shows it.
      const middleware = /\(middleware: (.*)\)$/m.exec(markdownOf(html))?.[1] ?? markdownOf(html);
      expect(middleware, middleware).toContain('AuditTrail');
      expect(middleware, middleware).not.toContain('(anonymous)');
      // (The code snippet shows the source as it is — the sections below are what was recorded.)
      const queries = sectionOf(html, 'queries');
      expect(queries).toContain('select * from users where email = ?');
      expect(queries).toContain('ada@example.com');
      expect(queries).toContain('secret columns: parameters hidden');
      expect(queries).not.toContain('argon2id');
      const log = sectionOf(html, 'logs');
      expect(log).toContain('Looking at the user');
      expect(log).not.toContain('tok-123');
      expect(markdownOf(html)).not.toMatch(/argon2id|tok-123/);
      expect(markdownOf(html)).toContain('## Queries (2)');
    } finally {
      await application.shutdown();
    }
  });

  it('shows the solution of the error — and the JSON error keeps message and exception, plus the solution', async () => {
    const { application, kernel } = await boot();
    try {
      const html = await (await kernel.request('/unbound', page)).text();
      expect(html).toContain('<article class="solution">');
      expect(html).toContain('Bind Mailer in a service provider');
      expect(html).toContain('marmeon discover');
      expect(html).toContain('<span class="code" title="docs/errors.md#server-error-codes">K1</span>');
      expect(html).not.toContain('href="docs/errors.md');
      expect(html).toContain('K1');

      const json = (await (await kernel.request('/unbound', { headers: { accept: 'application/json' } })).json()) as Record<string, any>;
      expect(json.message).toMatch(/No binding for \[Mailer\]/);
      expect(json.exception.name).toBe('ContainerError');
      expect(json.solution).toMatchObject({ title: 'Bind Mailer in a service provider', command: 'marmeon discover' });
    } finally {
      await application.shutdown();
    }
  });

  it('shows the code of the error in the Markdown and on its solution — an error without a code shows none', async () => {
    const { application, kernel } = await boot();
    try {
      const coded = await (await kernel.request('/unbound', page)).text();
      expect(markdownOf(coded)).toContain('- **Code:** K1');
      expect(markdownOf(coded)).toContain('- **Bind Mailer in a service provider** (K1) — ');
      const plain = await (await kernel.request('/explode/7', page)).text();
      expect(markdownOf(plain)).not.toContain('**Code:**');
      expect(plain).not.toContain('class="code"');
    } finally {
      await application.shutdown();
    }
  });

  it('answers a client-side visit with the page as HTML — the visit dialog shows it in its sandboxed frame', async () => {
    const { application, kernel } = await boot();
    try {
      const response = await kernel.request('/explode/7', visit);
      expect(response.status).toBe(500);
      expect(response.headers.get('x-marmeon')).toBeNull();
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await response.text()).toContain('The controller failed on purpose');
    } finally {
      await application.shutdown();
    }
  });

  it('leaves client errors (4xx) to the app’s error page', async () => {
    const { application, kernel } = await boot();
    try {
      const response = await kernel.request('/forbidden', visit);
      expect(response.status).toBe(403);
      expect(((await response.json()) as PageObject).component).toBe('errors/Error');
    } finally {
      await application.shutdown();
    }
  });

  it('masks a short sensitive route parameter by the route\'s pattern — on the page and in the Markdown', async () => {
    const { application, kernel } = await boot();
    try {
      const html = await (await kernel.request('/invite/483920?token=abc123', { headers: { accept: 'text/html' } })).text();
      expect(html).toContain('/invite/[redacted]');
      expect(html).not.toContain('483920');
      expect(html).not.toContain('abc123');
      expect(markdownOf(html)).not.toContain('483920');
      const explode = await (await kernel.request('/explode/7', { headers: { accept: 'text/html' } })).text();
      expect(explode).toContain('/explode/7');
    } finally {
      await application.shutdown();
    }
  });

  it('shows the URL of a request no route matched, masked as text as before', async () => {
    const { application, kernel } = await boot();
    try {
      const html = await (await kernel.request('/unrouted/483920?token=abc123', { headers: { accept: 'text/html' } })).text();
      expect(html).toContain('The middleware failed');
      expect(html).toContain('/unrouted/483920');
      expect(html).not.toContain('abc123');
    } finally {
      await application.shutdown();
    }
  });

  it('redacts the Cookie header — on the page and in the Markdown', async () => {
    const { application, kernel } = await boot();
    try {
      const html = await (await kernel.request('/explode/7', { headers: { accept: 'text/html', cookie: 'marmeon_session=s3ss10n-c00kie; theme=dark' } })).text();
      expect(html).not.toContain('s3ss10n-c00kie');
      expect(markdownOf(html)).not.toContain('s3ss10n-c00kie');
      expect(markdownOf(html)).toContain('"cookie": "[redacted]"');
    } finally {
      await application.shutdown();
    }
  });

  it('redacts the Authorization header — on the page and in the Markdown', async () => {
    const { application, kernel } = await boot();
    try {
      const html = await (await kernel.request('/explode/7', { headers: { accept: 'text/html', authorization: 'Bearer s3cr3t-b34r3r' } })).text();
      expect(html).not.toContain('s3cr3t-b34r3r');
      expect(markdownOf(html)).not.toContain('s3cr3t-b34r3r');
      expect(markdownOf(html)).toContain('"authorization": "[redacted]"');
    } finally {
      await application.shutdown();
    }
  });

  it('redacts a password in the body — on the page and in the Markdown', async () => {
    const { application, kernel } = await boot();
    try {
      const html = await (
        await kernel.request('/login', { method: 'POST', headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=ada%40example.com&password=hunter2-p4ss' })
      ).text();
      expect(html).toContain('Signing in failed');
      expect(html).toContain('ada@example.com');
      expect(html).not.toContain('hunter2-p4ss');
      expect(markdownOf(html)).not.toContain('hunter2-p4ss');
      expect(markdownOf(html)).toContain('"password": "[redacted]"');
    } finally {
      await application.shutdown();
    }
  });

  it('shows only the queries of its own request — not those of a request running at the same time', async () => {
    const { application, kernel } = await boot();
    try {
      const slow = kernel.request('/slow', page);
      while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
      await kernel.request('/quick');
      const queries = sectionOf(await (await slow).text(), 'queries');
      expect(queries).toContain('the slow request');
      expect(queries).not.toContain('the quick request');
    } finally {
      release = undefined;
      await application.shutdown();
    }
  });

  it('renders when server rendering itself is broken — the page needs neither the views nor SSR', async () => {
    const broken: PageRenderer = {
      render: () => Promise.reject(new Error('SSR is broken')),
      shell: () => Promise.reject(new Error('The shell is broken too')),
    };
    const { application, kernel } = await boot({ renderer: broken });
    try {
      const response = await kernel.request('/explode/7', page);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain('The controller failed on purpose');
    } finally {
      await application.shutdown();
    }
  });
});

describe('the development error page — only in development', () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'test' }, { NODE_ENV: 'production', APP_ENV: 'local' }] as Record<string, string>[]) {
    it(`${JSON.stringify(env)}: no recorder, no subscriber — the plain error page without stack, queries, headers or code`, async () => {
      const { application, kernel } = await boot({ env });
      try {
        expect(application.container.make(ServerConfig).debug).toBe(false);
        expect(application.container.has(DevRequestRecorder)).toBe(false);
        const response = await kernel.request('/explode/7', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, accept: 'text/html', authorization: 'Bearer s3cr3t-b34r3r' } });
        expect(response.status).toBe(500);
        const body = await response.text();
        const page = JSON.parse(body) as PageObject;
        expect(page.component).toBe('errors/Error');
        expect(page.props).toEqual({ status: 500, title: 'Server Error', message: 'Server Error', exception: null });
        for (const leak of ['The controller failed', 'select * from users', 'Bearer', 'error-page.test.ts', 'throw new Error']) expect(body).not.toContain(leak);
      } finally {
        await application.shutdown();
      }
    });
  }
});

describe('server-rendering errors in development', () => {
  it('go to the renderer’s overlay hook with their solutions — the page still renders in the browser', async () => {
    const reported: { error: unknown; component: string; titles: string[] }[] = [];
    const renderer: PageRenderer = {
      render: () => Promise.reject(new Error('[marmeon:R2] Page [Home] not found. Expected a default export in modules/Home/views/.tsx')),
      shell: async () => '<html><body><div id="app"></div></body></html>',
      failed: async (error, { component, solutions }) => {
        reported.push({ error, component, titles: solutions.map((solution) => solution.title) });
        return '<script data-overlay></script>';
      },
    };
    const { application, kernel } = await boot({ renderer });
    try {
      const response = await kernel.request('/home', page);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html><body><div id="app"></div><script data-overlay></script></body></html>');
      expect(reported).toEqual([{ error: expect.any(Error), component: 'Home', titles: ['Create modules/Home/views/Index.tsx'] }]);
    } finally {
      await application.shutdown();
    }
    // Outside development: the shell alone, the hook is never asked.
    const production = await boot({ env: { NODE_ENV: 'production' }, renderer });
    try {
      reported.length = 0;
      expect(await (await production.kernel.request('/home', page)).text()).toBe('<html><body><div id="app"></div></body></html>');
      expect(reported).toEqual([]);
    } finally {
      await production.application.shutdown();
    }
  });
});
