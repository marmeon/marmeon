import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createApplication, defineModule, Logger, type Application } from '@marmeon/core';
import { runWithRequest } from '@marmeon/core/internal';
import { Connections, DatabaseServiceProvider, Migrator, Schema } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, view } from '@marmeon/http';
import { html, Mailer, MailServiceProvider, type Mailable } from '@marmeon/mail';
import { Queue, QueueConnections, QueueServiceProvider } from '@marmeon/queue';
import { QUEUE_MIGRATION } from '@marmeon/queue/internal';
import { Router, type HttpContext } from '@marmeon/router';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { DevDocument } from '@marmeon/server/internal';
import * as v from 'valibot';
import { afterAll, describe, expect, it } from 'vitest';
import { DevtoolsServiceProvider, DevtoolsStore, type AnyEntry } from './index.ts';
import { BASE, MAIL_CSP } from './pages/index.ts';
import { enableDevtoolsForTests } from './test-opt-in.ts';
import type { DevtoolsTester } from './tester.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { openRoutes } from './test-helpers/open-routes.ts';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

class ReportJob {
  static readonly job = 'test.report';
  static readonly schema = v.object({ personId: v.number() });
  async handle() {}
}

class ScriptMail implements Mailable {
  envelope() {
    return { to: 'ada@example.com', subject: 'Hello <b>Ada</b>' };
  }
  content() {
    return html`<p>Hi</p>${html`<script>parent.document.title = 'pwned'; fetch('/_marmeon/devtools/api/entries')</script>`}<a href="http://localhost/reset-password/${'f'.repeat(40)}">Reset</a>`;
  }
}

class ShowPersonController {
  readonly #queue: Queue;
  readonly #mailer: Mailer;
  readonly #logger: Logger;
  constructor(queue: Queue, mailer: Mailer, logger: Logger) {
    this.#queue = queue;
    this.#mailer = mailer;
    this.#logger = logger;
  }
  async handle(ctx: HttpContext<{}, { person: string }>) {
    await this.#queue.dispatch(ReportJob, { personId: 1 });
    await this.#mailer.send(new ScriptMail());
    this.#logger.info('Looked at a person');
    return view('people/Show', { person: { name: ctx.params.person } });
  }
}

const routes = openRoutes((Route) => {
  Route.get('/people/:person', ShowPersonController).name('people.show');
  Route.get('/plain', () => ({ ok: true }));
});

interface Booted {
  readonly app: Application;
  readonly kernel: ReturnType<typeof createHttpKernel>;
  readonly tester?: DevtoolsTester;
}

async function boot(env: Record<string, string> = {}, { test = true }: { test?: boolean } = {}): Promise<Booted> {
  const root = tempDir('marmeon-devtools-pages-');
  roots.push(root);
  let tester: DevtoolsTester | undefined;
  const app = await createApplication({
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, DatabaseServiceProvider, QueueServiceProvider, MailServiceProvider, DevtoolsServiceProvider],
    modules: [defineModule({ name: 'people', routes, jobs: [ReportJob], migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { NODE_ENV: 'test', APP_KEY: generateKey(), APP_URL: 'http://app.test:8080', DB_CONNECTION: 'sqlite', DB_DATABASE: join(root, 'db.sqlite'), QUEUE_CONNECTION: 'database', MAIL_MAILER: 'array', LOG_LEVEL: 'silent', ...env },
    override: (container) => {
      if (test) tester = enableDevtoolsForTests(container);
    },
  });
  const connections = app.container.make(Connections);
  await new Migrator(app, connections).migrate();
  const migration = ((await import(QUEUE_MIGRATION.href)) as { default: { up(schema: Schema): Promise<void> } }).default;
  await migration.up(new Schema(connections.get(), connections.options().driver));
  return { app, kernel: createHttpKernel(app), ...(tester ? { tester } : {}) };
}

/** Every path of the devtools in the route table — parameters filled with an id that does not exist. */
function devtoolsPaths(app: Application): string[] {
  return app.container
    .make(Router)
    .routes.filter((route) => route.path.startsWith(BASE))
    .map((route) => route.path.replace(/:[\w]+/g, 'nothing-here'));
}

/** Reads a stream until `until` matches what came so far (or the time is up), then cancels it. */
async function readStream(response: Response, until: RegExp, ms = 5000): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  try {
    while (!until.test(text) && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), Math.max(1, deadline - Date.now())))]);
      if (next === 'timeout' || next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return text;
}

describe('the devtools pages: only where the devtools run', () => {
  // APP_ENV names the environment and opens nothing: production with APP_ENV=local has no devtools either.
  it.each([[{ NODE_ENV: 'test' }], [{ NODE_ENV: 'production', APP_ENV: 'local' }], [{ NODE_ENV: 'production' }], [{}]])('do not exist with %j and no opt-in — not one route', async (environment) => {
    const { app, kernel } = await boot(environment, { test: false });
    try {
      expect(devtoolsPaths(app)).toEqual([]);
      expect((await kernel.request(BASE)).status).toBe(404);
      expect((await kernel.request(`${BASE}/api/entries`)).status).toBe(404);
    } finally {
      await app.shutdown();
    }
  });

  it('every path the development route table lists answers 404 in production — the routes are not registered there', async () => {
    const development = await boot();
    const paths = devtoolsPaths(development.app);
    await development.app.shutdown();
    expect(paths.length).toBeGreaterThanOrEqual(30);
    const production = await boot({ NODE_ENV: 'production' }, { test: false });
    try {
      expect(devtoolsPaths(production.app)).toEqual([]);
      for (const path of [...paths, `${BASE}/requests/x`, `${BASE}/api/requests/x`]) {
        const response = await production.kernel.request(path, { headers: { host: 'localhost' } });
        await response.body?.cancel();
        expect(response.status, path).toBe(404);
      }
    } finally {
      await production.app.shutdown();
    }
  });

  it('exist with the opt-in: every page, the API and the stream — GET only, no cookies, never cached, framed only by this origin', async () => {
    const { app, kernel } = await boot();
    try {
      const paths = devtoolsPaths(app);
      expect(paths.length).toBeGreaterThanOrEqual(30);
      expect(paths).toEqual(expect.arrayContaining([BASE, `${BASE}/requests`, `${BASE}/queue`, `${BASE}/schedule`, `${BASE}/stream`, `${BASE}/api/entries`, `${BASE}/api/requests/nothing-here`]));
      // GET only: the route table has no other method under the base.
      const methods = new Set(app.container.make(Router).routes.filter((route) => route.path.startsWith(BASE)).flatMap((route) => route.methods));
      expect([...methods]).toEqual(['GET']);
      for (const path of paths) {
        const response = await kernel.request(path);
        if (path.endsWith('/stream')) await response.body?.cancel();
        else await response.arrayBuffer();
        expect(response.status, path).toBeLessThan(500);
        expect(response.headers.get('set-cookie'), path).toBeNull();
        expect(response.headers.get('cache-control'), path).toBe('no-store');
        expect(response.headers.get('content-security-policy'), path).toContain("frame-ancestors 'self'");
        expect([...response.headers.keys()].filter((name) => name.startsWith('access-control-')), path).toEqual([]);
        // Nothing but GET (and HEAD) reaches a handler — a write never does.
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
          const other = await kernel.request(path, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
          expect(other.status, `${method} ${path}`).toBe(404);
        }
      }
    } finally {
      await app.shutdown();
    }
  });

  it('name the app\'s environment in the header — APP_ENV, escaped like everything else', async () => {
    const { app, kernel } = await boot({ APP_ENV: 'qa <b>' });
    try {
      const page = await (await kernel.request(BASE)).text();
      expect(page).toContain('<span class="dev">development only</span><span class="dev">APP_ENV=qa &lt;b&gt;</span>');
    } finally {
      await app.shutdown();
    }
  });

  it('answer only localhost, 127.0.0.1, [::1] and the host of APP_URL — any other Host gets 403 (DNS rebinding)', async () => {
    const { app, kernel } = await boot();
    try {
      for (const host of ['localhost', 'localhost:3960', '127.0.0.1:3960', '[::1]:3960', 'app.test', 'APP.test:8080']) {
        expect((await kernel.request(`${BASE}/api/status`, { headers: { host } })).status, host).toBe(200);
      }
      for (const host of ['evil.example', 'evil.example:3960', 'localhost.evil.example', 'app.test.evil.example', '127.0.0.2', 'localhost@evil.example', '']) {
        for (const path of devtoolsPaths(app)) {
          const response = await kernel.request(path, { headers: { host } });
          expect(response.status, `${host} ${path}`).toBe(403);
          expect(await response.text()).not.toContain('"entries"');
        }
      }
      // The URL's host counts when no Host header comes (in-process requests).
      expect((await kernel.request(`http://evil.example${BASE}/api/status`)).status).toBe(403);
    } finally {
      await app.shutdown();
    }
  });
});

describe('what the pages show', () => {
  it('escape what a request carried — <script> in its path and query is text', async () => {
    const { app, kernel, tester } = await boot();
    try {
      await kernel.request('/people/%3Cscript%3Ealert(1)%3C%2Fscript%3E?q=%3Cscript%3Ealert(2)%3C%2Fscript%3E');
      await tester!.settled();
      const request = tester!.assertRecorded('request', (content) => content.route === 'people.show');
      for (const path of [`${BASE}/requests`, `${BASE}/requests/${request.id}`, BASE]) {
        const body = await (await kernel.request(path)).text();
        // The path as a person reads it — decoded, so `<script>` is there as text, escaped.
        expect(body, path).toContain('/people/&lt;script&gt;alert(1)&lt;');
        expect(body, path).not.toMatch(/<script>alert\(/);
      }
      // The query's values (decoded when recorded) on the request's page.
      const detail = await (await kernel.request(`${BASE}/requests/${request.id}`)).text();
      expect(detail).toContain('&quot;q&quot;: &quot;&lt;script&gt;alert(2)&lt;/script&gt;&quot;');
      const search = await (await kernel.request(`${BASE}/requests?search=${encodeURIComponent('"><script>alert(3)</script>')}`)).text();
      expect(search).toContain('value="&quot;&gt;&lt;script&gt;alert(3)&lt;/script&gt;"');
      expect(search).not.toContain('<script>alert(3)');
    } finally {
      await app.shutdown();
    }
  });

  it('show a recorded mail in a sandboxed frame — its HTML served with a sandbox CSP, no script of it runs', async () => {
    const { app, kernel, tester } = await boot();
    try {
      await kernel.request('/people/ada');
      await tester!.settled();
      const mail = tester!.assertRecorded('mail', (content) => content.mailable === 'ScriptMail');
      const page = await (await kernel.request(`${BASE}/mails/${mail.id}`)).text();
      const frame = /<iframe class="mail"[^>]*>/.exec(page)?.[0];
      expect(frame).toMatch(/ sandbox /);
      expect(frame).not.toMatch(/allow-scripts|allow-same-origin/);
      expect(frame).toContain(`src="${BASE}/mails/${mail.id}/html"`);
      // The page itself carries none of the mail's markup.
      expect(page).not.toContain("parent.document.title = 'pwned'");
      expect(page).toContain('Hello &lt;b&gt;Ada&lt;/b&gt;');

      const body = await kernel.request(`${BASE}/mails/${mail.id}/html`);
      const csp = body.headers.get('content-security-policy') ?? '';
      expect(csp).toBe(MAIL_CSP);
      // `sandbox` without allow-scripts: a script of the mail never runs — also opened in a tab of its own.
      expect(csp.split('; ')).toContain('sandbox');
      expect(csp).not.toMatch(/script-src|allow-/);
      const markup = await body.text();
      expect(markup).toContain('<script>parent.document.title'); // the mail as it was — only the CSP and the sandbox keep it inert
      expect(markup).toContain('/reset-password/[redacted]'); // its token path masked when recorded
    } finally {
      await app.shutdown();
    }
  });

  it('tie a request to what it set off — its queries, log, queued job and mail; then the job a worker ran, by the request id', async () => {
    const { app, kernel, tester } = await boot();
    try {
      const response = await kernel.request('/people/ada');
      const requestId = response.headers.get('x-request-id')!;
      await app.container.make(QueueConnections).worker('database', 5).run({ queues: ['default'], stopWhenEmpty: true });
      await tester!.settled();
      const request = tester!.assertRecorded('request', (content) => content.route === 'people.show');
      const page = await (await kernel.request(`${BASE}/requests/${request.id}`)).text();
      expect(page).toContain('ShowPersonController');
      expect(page).toContain('ScriptMail');
      expect(page).toContain('Looked at a person');
      expect(page).toMatch(/What it set off/);
      expect(page).toMatch(/Job test\.report — attempt 1, done/);
      // The request id leads to the request's page too (the in-page bar knows only `x-request-id`).
      const byRequestId = await kernel.request(`${BASE}/requests/${requestId}`);
      expect(byRequestId.status).toBe(302);
      expect(byRequestId.headers.get('location')).toBe(`${BASE}/requests/${request.id}`);

      const api = (await (await kernel.request(`${BASE}/api/requests/${requestId}`)).json()) as { requestId: string; entries: AnyEntry[]; batches: string[] };
      expect(api.requestId).toBe(requestId);
      expect(api.batches.length).toBe(2); // the request's, the job attempt's
      expect(api.entries.map((entry) => entry.type)).toEqual(expect.arrayContaining(['request', 'job', 'mail', 'log']));
      expect(api.entries.find((entry) => entry.type === 'job' && entry.content.status === 'done')?.batch).not.toBe(request.batch);

      const list = (await (await kernel.request(`${BASE}/api/entries?type=request&type=mail&limit=1`)).json()) as { entries: AnyEntry[]; next: string | null };
      expect(list.entries).toHaveLength(1);
      expect(list.next).toBe(list.entries[0]!.id);
      const older = (await (await kernel.request(`${BASE}/api/entries?type=request,mail&before=${list.next}`)).json()) as { entries: AnyEntry[] };
      expect(older.entries.every((entry) => entry.id !== list.next)).toBe(true);
      expect((await kernel.request(`${BASE}/api/entries?type=nonsense`)).status).toBe(400);
      expect((await kernel.request(`${BASE}/api/entries/${request.id}`)).status).toBe(200);
      expect((await kernel.request(`${BASE}/api/entries/nothing`)).status).toBe(404);
    } finally {
      await app.shutdown();
    }
  });

  it('filter by status, route, tag and request id, search, and page', async () => {
    const { app, kernel, tester } = await boot();
    try {
      await kernel.request('/plain');
      await kernel.request('/people/grace');
      await kernel.request('/nowhere');
      await tester!.settled();
      const rows = async (query: string) => ((await (await kernel.request(`${BASE}/requests?${query}`)).text()).match(/<tr><td class="time">/g) ?? []).length;
      expect(await rows('')).toBe(3);
      expect(await rows('status=4xx')).toBe(1);
      expect(await rows('status=2xx')).toBe(2);
      expect(await rows('route=people.show')).toBe(1);
      expect(await rows('search=grace')).toBe(1);
      expect(await rows('tag=status%3A404')).toBe(1);
      const [plain] = tester!.entries('request').filter((entry) => entry.content.path === '/plain');
      expect(await rows(`requestId=${plain!.requestId}`)).toBe(1);
    } finally {
      await app.shutdown();
    }
  });

  it('stream new entries (SSE) — from every process writing to the store — with the row the page inserts', async () => {
    const { app, kernel } = await boot();
    try {
      const stream = await kernel.request(`${BASE}/stream?type=request&rows=1`, { headers: { accept: 'text/event-stream' } });
      expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      // Another process's entry: written to the store directly, as a worker's would be.
      const store = app.container.make(DevtoolsStore);
      setTimeout(() => {
        void store.write([{ id: 'zzzzzzzzz00aaaaaaaaaa', type: 'log', at: Date.now(), batch: 'b1', tags: [], content: { level: 'info', message: 'not a request', context: {} } }]);
        void kernel.request('/plain');
      }, 300);
      const text = await readStream(stream, /event: entry/);
      expect(text).toMatch(/^retry: 2000/);
      expect(text).toContain('event: ready');
      const data = JSON.parse(/event: entry\ndata: (.*)\n/.exec(text)![1]!) as { entry: AnyEntry; row: string };
      expect(data.entry.type).toBe('request');
      expect(data.row).toMatch(/^<tr><td class="time">/);
      expect(text).not.toContain('not a request');
      expect((await kernel.request(`${BASE}/stream?type=nonsense`)).status).toBe(400);
    } finally {
      await app.shutdown();
    }
  });

  it('show the queues and the failed jobs, read-only — retrying is a command to copy', async () => {
    const { app, kernel } = await boot();
    try {
      await app.container.make(Queue).dispatch(ReportJob, { personId: 7 });
      await app.container.make(Queue).dispatch(ReportJob, { personId: 8 }, { delay: 60 });
      const connections = app.container.make(QueueConnections);
      await connections.failed().record({
        uuid: 'f00d-0001',
        connection: 'database',
        queue: 'mail',
        job: 'test.report',
        payload: JSON.stringify({ v: 1, uuid: 'f00d-0001', job: 'test.report', data: { personId: 9, password: 'hunter2' }, requestId: 'req-1' }),
        exception: 'Error: The report failed, password=hunter2\n    at handle (/app/jobs.ts:1:1)',
        failedAt: Date.now(),
      });
      // A record without a version, or of a newer one: no payload shown, and no retry for the one `queue:retry` refuses.
      await connections.failed().record({
        uuid: 'f00d-0002',
        connection: 'database',
        queue: 'mail',
        job: 'test.report',
        payload: JSON.stringify({ uuid: 'f00d-0002', job: 'test.report', data: { personId: 1, secret: 'old-release-data' } }),
        exception: 'Error: before versions',
        failedAt: Date.now() - 1000,
      });
      await connections.failed().record({
        uuid: 'f00d-0003',
        connection: 'database',
        queue: 'mail',
        job: 'test.report',
        payload: JSON.stringify({ v: 9, uuid: 'f00d-0003', job: 'test.report', data: { secret: 'newer-release-data' } }),
        exception: 'Error: held too long',
        failedAt: Date.now() - 2000,
      });
      const page = await (await kernel.request(`${BASE}/queue`)).text();
      expect(page).not.toContain('queue:retry f00d-0002');
      expect(page).toContain('marmeon queue:forget f00d-0002');
      expect(page).toContain('marmeon queue:retry f00d-0003');
      expect(page).not.toContain('old-release-data');
      expect(page).not.toContain('newer-release-data');
      expect(page).toMatch(/<td class="mono">default<\/td><td class="num">2<\/td><td class="num">1<\/td><td class="num">1<\/td><td class="num">0<\/td>/);
      expect(page).toContain('Failed jobs (3)');
      expect(page).toContain('marmeon queue:retry f00d-0001');
      expect(page).toContain('marmeon queue:forget f00d-0001');
      expect(page).not.toContain('hunter2'); // the stored error and payload, redacted
      expect(page).toContain(`href="${BASE}/requests?requestId=req-1"`);

      const api = (await (await kernel.request(`${BASE}/api/queue`)).json()) as { available: boolean; failedTotal: number; connections: { queues: { name: string; size: number }[] }[] };
      expect(api).toMatchObject({ available: true, failedTotal: 3 });
      expect(api.connections[0]!.queues.find((queue) => queue.name === 'default')?.size).toBe(2);
      // Still there: nothing was retried, forgotten or worked by looking.
      expect(await connections.failed().all()).toHaveLength(3);
      expect(await connections.driver('database').size('default')).toBe(2);
    } finally {
      await app.shutdown();
    }
  });
});

describe('the in-page bar’s side on the server', () => {
  it('/api/source: where a controller or a view is, for "open in editor" — inside the app only, nothing else', async () => {
    const { app, kernel } = await boot();
    try {
      mkdirSync(join(app.root, 'modules/people/controllers'), { recursive: true });
      mkdirSync(join(app.root, 'modules/people/views'), { recursive: true });
      writeFileSync(join(app.root, 'modules/people/controllers/People.ts'), `import { Controller } from '@marmeon/http';\n\nexport class ListPeopleController extends Controller {}\n\nexport class ShowPersonController extends Controller {}\n`);
      writeFileSync(join(app.root, 'modules/people/views/Show.tsx'), 'export default function Show() { return null; }\n');
      const source = async (query: string) => {
        const response = await kernel.request(`${BASE}/api/source?${query}`, { headers: { host: 'localhost' } });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      };
      expect(await source('controller=ShowPersonController')).toEqual({
        status: 200,
        body: { file: join(app.root, 'modules/people/controllers/People.ts'), display: 'modules/people/controllers/People.ts', line: 5, editor: `/__open-in-editor?file=${encodeURIComponent(`${join(app.root, 'modules/people/controllers/People.ts')}:5`)}` },
      });
      expect(await source('view=people/Show')).toMatchObject({ status: 200, body: { display: 'modules/people/views/Show.tsx', line: 1 } });
      // A view's file outside the app (a sibling directory): never found, whatever the name says.
      mkdirSync(join(app.root, '..', `${basename(app.root)}-sibling`), { recursive: true });
      writeFileSync(join(app.root, '..', `${basename(app.root)}-sibling`, 'Leak.tsx'), 'export default null;\n');
      roots.push(join(app.root, '..', `${basename(app.root)}-sibling`));
      for (const query of ['controller=Missing', 'controller=a.b', 'controller=', 'view=../../etc/passwd', 'view=people/../../x', 'view=people', 'nothing=1', `view=x/../../../../${basename(app.root)}-sibling/Leak`]) {
        expect((await source(query)).status, query).toBe(404);
      }
    } finally {
      await app.shutdown();
    }
  });

  it('puts the bar into the head of every development document: its script (served by Vite) and the request id, escaped', async () => {
    const { app } = await boot({ NODE_ENV: 'development' });
    try {
      const head = runWithRequest({ requestId: '"><script>alert(1)</script>' }, () => app.container.make(DevDocument).head);
      expect(head).toBe(
        '<meta name="marmeon-devtools" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" data-marmeon-devtools>\n<script type="module" src="/@id/@marmeon/devtools/client" nonce="__marmeon_csp_nonce__" data-marmeon-devtools></script>',
      );
      expect(app.container.make(DevDocument).body).toBe(''); // no link: the bar's pill is the way in
    } finally {
      await app.shutdown();
    }
  });
});
