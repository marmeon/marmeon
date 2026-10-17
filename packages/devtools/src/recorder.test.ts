import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application, createApplication, defineModule, ErrorSolutions, EventDispatcher, EventRegistry, Logger, type ServiceProviderClass } from '@marmeon/core';
import { coreSolutions, messageBase, trace } from '@marmeon/core/internal';
import { EventFake } from '@marmeon/core/testing';
import { channels } from '@marmeon/core/diagnostics';
import { Connections, Database, DatabaseServiceProvider, Migrator, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, optional, SharedData, view } from '@marmeon/http';
import { html, Mailer, MailServiceProvider, type Mailable } from '@marmeon/mail';
import { Queue, QueueServiceProvider } from '@marmeon/queue';
import type { HttpContext } from '@marmeon/router';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { DevtoolsStore, FileStore, MemoryStore, type AnyEntry } from './index.ts';
import { Recorder } from './recorder.ts';
import { enableDevtoolsForTests } from './test-opt-in.ts';
import type { DevtoolsTester } from './tester.ts';
import { DevtoolsServiceProvider } from './provider.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { openRoutes } from './test-helpers/open-routes.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA';
const API_TOKEN = `marmeon_7|${randomBytes(30).toString('hex').slice(0, 40)}`;

class ReportJob {
  static readonly job = 'test.report';
  static readonly schema = v.object({ personId: v.number() });
  readonly #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }
  async handle(payload: { personId: number }) {
    await sql`select count(*) as n from people where id = ${payload.personId}`.execute(this.#db);
  }
}

class SecretJob {
  static readonly job = 'test.secret';
  static readonly schema = v.object({ code: v.string() });
  static readonly encrypted = true;
  async handle() {}
}

class PersonViewed {
  static readonly event = 'people.viewed';
  readonly #event = true;
  readonly person: number;
  readonly token: string;
  constructor(person: number, token: string) {
    this.person = person;
    this.token = token;
  }
}

class ResetMail implements Mailable {
  readonly #token: string;
  constructor(token: string) {
    this.#token = token;
  }
  envelope() {
    return { to: 'ada@example.com', subject: 'Reset your password' };
  }
  content() {
    return html`<a href="http://localhost/reset-password/${this.#token}?email=ada%40example.com">Reset</a> <a href="http://localhost/verify/1?expires=99&signature=a1b2c3d4e5f6">Verify</a>`;
  }
}

class ShowPersonController {
  readonly #db: Database;
  readonly #queue: Queue;
  readonly #logger: Logger;
  readonly #events: EventDispatcher;
  constructor(db: Database, queue: Queue, logger: Logger, events: EventDispatcher) {
    this.#db = db;
    this.#queue = queue;
    this.#logger = logger;
    this.#events = events;
  }
  async handle(ctx: HttpContext<{}, { person: string }>) {
    const person = Number(ctx.params.person);
    await this.#db.selectFrom('people' as never).selectAll().where('email' as never, '=', 'ada@example.com' as never).execute();
    await this.#queue.dispatch(ReportJob, { personId: person });
    await this.#queue.dispatch(SecretJob, { code: 'top-secret-code' });
    this.#logger.info('Looked at a person', { person, api_key: 'key-123' });
    await this.#events.dispatch(new PersonViewed(person, 'event-token-value'));
    return view('people/Show', { person: { id: person, name: 'Ada' }, list: Array.from({ length: 50 }, (_, i) => i) });
  }
}

class LoginController {
  readonly #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }
  async handle(ctx: HttpContext) {
    const input = await ctx.input();
    await sql`update people set password = ${HASH} where email = ${String(input.email)}`.execute(this.#db);
    return { ok: true };
  }
}

class ResetController {
  readonly #mailer: Mailer;
  constructor(mailer: Mailer) {
    this.#mailer = mailer;
  }
  async handle(ctx: HttpContext<{}, { token: string }>) {
    await this.#mailer.send(new ResetMail(ctx.params.token));
    return { ok: true };
  }
}

class TransactionController {
  readonly #connections: Connections;
  constructor(connections: Connections) {
    this.#connections = connections;
  }
  async handle() {
    await this.#connections.transaction(async () => {
      await sql`insert into people (email, password) values (${'grace@example.com'}, ${'x'})`.execute(this.#connections.get());
      await sql`select count(*) from people`.execute(this.#connections.get());
    });
    return { ok: true };
  }
}

/** A page with a shared prop and an optional one it leaves out — the badges of the in-page bar. */
class ShowOriginsController {
  readonly #shared: SharedData;
  constructor(shared: SharedData) {
    this.#shared = shared;
  }
  handle() {
    (this.#shared as unknown as { share(key: string, value: unknown): void }).share('auth', { user: 'ada' });
    return view('people/Origins', { own: 1, stats: optional(() => ({ links: 3 })) });
  }
}

const routes = openRoutes((Route) => {
  Route.get('/people/:person', ShowPersonController).name('people.show');
  Route.get('/origins', ShowOriginsController).name('origins');
  Route.post('/login', LoginController).name('login');
  Route.get('/reset-password/:token', ResetController).name('password.reset');
  Route.get('/transaction', TransactionController).name('transaction');
  Route.get('/fail', () => {
    throw new Error(`The report failed, password=hunter2 with ${API_TOKEN}`);
  });
  Route.get('/ignored', () => ({ ok: true }));
});

interface Booted {
  readonly app: Application;
  readonly root: string;
  readonly kernel: ReturnType<typeof createHttpKernel>;
  readonly tester?: DevtoolsTester;
}

async function boot(env: Record<string, string> = {}, options: { test?: boolean; config?: string; providers?: ServiceProviderClass[] } = {}): Promise<Booted> {
  const root = tempDir('marmeon-devtools-');
  if (options.config) {
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'devtools.ts'), options.config);
  }
  let tester: DevtoolsTester | undefined;
  const app = await createApplication({
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, DatabaseServiceProvider, QueueServiceProvider, MailServiceProvider, ...(options.providers ?? [DevtoolsServiceProvider])],
    modules: [defineModule({ name: 'people', routes, jobs: [ReportJob, SecretJob], migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { NODE_ENV: 'test', APP_KEY: generateKey(), DB_CONNECTION: 'sqlite', DB_DATABASE: join(root, 'db.sqlite'), QUEUE_CONNECTION: 'sync', MAIL_MAILER: 'array', ...env },
    override: (container) => {
      if (options.test) tester = enableDevtoolsForTests(container);
    },
  });
  const connections = app.container.make(Connections);
  // `people.password` is `.secret()` in its migration — the migrator's bookkeeping tells the query channel.
  await new Migrator(app, connections).migrate();
  await sql`insert into people (email) values ('ada@example.com')`.execute(connections.get());
  return { app, root, kernel: createHttpKernel(app), ...(tester ? { tester } : {}) };
}

/** Every line in the app's devtools directory, as text. */
function files(root: string): string {
  const directory = join(root, 'storage', 'framework', 'devtools');
  if (!existsSync(directory)) return '';
  return readdirSync(directory)
    .map((name) => readFileSync(join(directory, name), 'utf8'))
    .join('');
}

describe('the gate (fail closed, development only)', () => {
  it.each([[{ NODE_ENV: 'test' }], [{ NODE_ENV: 'production', APP_ENV: 'local' }], [{}]])('subscribes to nothing and writes nothing with %j', async (environment) => {
    const { app, root, kernel } = await boot(environment);
    try {
      expect(app.container.has(Recorder)).toBe(false);
      expect(app.container.has(DevtoolsStore)).toBe(false);
      await kernel.request('/people/1');
      expect(channels.built(app)).toBe(0);
      expect(existsSync(join(root, 'storage', 'framework', 'devtools'))).toBe(false);
    } finally {
      await app.shutdown();
    }
  });

  it('records with NODE_ENV=development — into NDJSON files under storage/framework/devtools', async () => {
    const { app, root, kernel } = await boot({ NODE_ENV: 'development' });
    try {
      expect(app.container.make(DevtoolsStore)).toBeInstanceOf(FileStore);
      await kernel.request('/people/1');
      await app.container.make(Recorder).settled();
      const lines = files(root).trim().split('\n');
      expect(lines.length).toBeGreaterThan(3);
      expect(lines.map((line) => (JSON.parse(line) as AnyEntry).type)).toContain('request');
    } finally {
      await app.shutdown();
    }
  });

  it('stays off in development with DEVTOOLS_ENABLED=false', async () => {
    const { app, root, kernel } = await boot({ NODE_ENV: 'development', DEVTOOLS_ENABLED: 'false' });
    try {
      await kernel.request('/people/1');
      expect(app.container.has(Recorder)).toBe(false);
      expect(existsSync(join(root, 'storage', 'framework', 'devtools'))).toBe(false);
    } finally {
      await app.shutdown();
    }
  });

  it('fails the start with DEVTOOLS_ENABLED=true where the app is protected — and a test opt-in there (no NODE_ENV too; APP_ENV opens nothing)', async () => {
    await expect(boot({ NODE_ENV: 'production', DEVTOOLS_ENABLED: 'true' })).rejects.toThrow(/DEVTOOLS_ENABLED=true with production \(APP_ENV=production\)[\s\S]*never run in production or without NODE_ENV, whatever APP_ENV says/);
    await expect(boot({ NODE_ENV: 'production', APP_ENV: 'local', DEVTOOLS_ENABLED: 'true' })).rejects.toThrow(/DEVTOOLS_ENABLED=true with production \(APP_ENV=local\)/);
    await expect(boot({ NODE_ENV: '', DEVTOOLS_ENABLED: 'true' })).rejects.toThrow(/DEVTOOLS_ENABLED=true with production \(APP_ENV=production, NODE_ENV unset\)/);
    // In any case — and only true or false: 1 is no way round the check.
    await expect(boot({ NODE_ENV: 'production', DEVTOOLS_ENABLED: 'TRUE' })).rejects.toThrow(/DEVTOOLS_ENABLED=true with production \(APP_ENV=production\)/);
    await expect(boot({ NODE_ENV: 'production', DEVTOOLS_ENABLED: '1' })).rejects.toThrow(/devtools: DEVTOOLS_ENABLED — DEVTOOLS_ENABLED must be true or false\./);
    await expect(boot({ NODE_ENV: 'production' }, { test: true })).rejects.toThrow(/NODE_ENV=production — they never run in production/);
    await expect(boot({ NODE_ENV: 'production', APP_ENV: 'local' }, { test: true })).rejects.toThrow(/NODE_ENV=production — they never run/);
    // What `marmeon` prints with it: the devtools' own solution — not "set the variables in .env".
    const error = await boot({ NODE_ENV: 'production', DEVTOOLS_ENABLED: 'true' }).catch((failure: unknown) => failure);
    const solutions = await new ErrorSolutions([...DevtoolsServiceProvider.solutions, ...coreSolutions]).find(error);
    expect(solutions.map((solution) => solution.title)).toEqual(['Remove DEVTOOLS_ENABLED in production']);
  });

  it('cannot be turned on outside development with DEVTOOLS_ENABLED=true', async () => {
    const { app } = await boot({ NODE_ENV: 'test', DEVTOOLS_ENABLED: 'true' });
    try {
      expect(app.container.has(Recorder)).toBe(false);
      expect(channels.built(app)).toBe(0);
    } finally {
      await app.shutdown();
    }
  });

  it('records in a test only when it opts in — into memory', async () => {
    const { app, tester, kernel } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      expect(app.container.make(DevtoolsStore)).toBeInstanceOf(MemoryStore);
      await kernel.request('/people/1');
      expect(tester!.entries('request')).toHaveLength(1);
    } finally {
      await app.shutdown();
    }
  });
});

describe('what the recorder keeps', () => {
  it('a request with its queries, jobs, log entries and events — one batch, tied by the request id', async () => {
    const { app, tester, kernel } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      const response = await kernel.request('/people/7?page=2&token=query-token', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, cookie: 'marmeon_session=s3ss10n', authorization: `Bearer ${API_TOKEN}` } });
      const requestId = response.headers.get('x-request-id')!;
      const request = tester!.assertRecorded('request', (content) => content.route === 'people.show');
      expect(request.requestId).toBe(requestId);
      expect(request.tags).toEqual(expect.arrayContaining(['status:200', 'route:people.show', 'GET']));
      expect(request.content).toMatchObject({ method: 'GET', path: '/people/7', routePath: '/people/:person', controller: 'ShowPersonController', status: 200, inProcess: false });
      expect(request.content.query).toEqual({ page: '2', token: '[redacted]' });
      expect(request.content.url).toBe('http://localhost/people/7?page=2&token=[redacted]');
      expect(request.content.headers.cookie).toBe('[redacted]');
      expect(request.content.headers.authorization).toBe('[redacted]');
      // Prop sizes per key, never the values.
      expect(request.content.page).toMatchObject({ kind: 'page', component: 'people/Show', props: { person: JSON.stringify({ id: 7, name: 'Ada' }).length, list: JSON.stringify(Array.from({ length: 50 }, (_, i) => i)).length } });
      expect(JSON.stringify(request.content.page)).not.toContain('Ada');
      // Where the props came from: shared and left-out optional props, by name.
      await kernel.request('/origins', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
      expect(tester!.assertRecorded('request', (content) => content.route === 'origins').content.page).toMatchObject({ component: 'people/Origins', shared: ['auth'], optional: ['stats'] });

      const batch = tester!.batch(request.batch);
      expect(batch.map((entry) => entry.type)).toEqual(expect.arrayContaining(['request', 'query', 'job', 'log', 'event']));
      expect(batch.filter((entry) => entry.type === 'job').map((entry) => entry.content.status)).toEqual(['queued', 'queued']);
      expect(batch.every((entry) => entry.requestId === requestId)).toBe(true);
      // The sync job ran inside the request: its attempt is a batch of its own, tied to the request.
      const attempt = tester!.assertRecorded('job', (job) => job.status === 'done' && job.name === 'test.report');
      expect(attempt.requestId).toBe(requestId);
      expect(attempt.batch).not.toBe(request.batch);
      expect(attempt.content.payload).toEqual({ personId: 7 });
      expect(tester!.batch(attempt.batch).some((entry) => entry.type === 'query' && entry.content.sql.includes('count(*)'))).toBe(true);
      // An encrypted job's payload is never shown — neither queued nor run.
      const secret = tester!.entries('job').filter((job) => job.content.name === 'test.secret');
      expect(secret.map((job) => job.content.status).sort()).toEqual(['done', 'queued']);
      expect(secret.every((job) => job.content.payload === '[encrypted]')).toBe(true);
      expect(JSON.stringify(tester!.entries())).not.toContain('top-secret-code');
      // Log context and event fields by key.
      expect(tester!.assertRecorded('log', (log) => log.message === 'Looked at a person').content.context).toMatchObject({ person: 7, api_key: '[redacted]' });
      expect(tester!.assertRecorded('event', (event) => event.name === 'people.viewed').content).toMatchObject({ class: 'PersonViewed', payload: { person: 7, token: '[redacted]' } });
      expect(JSON.stringify(tester!.entries())).not.toMatch(/s3ss10n|query-token|event-token-value|key-123/);
      expect(JSON.stringify(tester!.entries())).not.toContain(API_TOKEN.split('|')[1]);
    } finally {
      await app.shutdown();
    }
  });

  it('a statement touching secret columns without its parameters, the body without passwords', async () => {
    const { app, tester, kernel } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      await kernel.request('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=ada%40example.com&password=hunter2&_token=csrf-value' });
      const update = tester!.assertRecorded('query', (query) => query.sql.startsWith('update people'));
      expect(update.content).toMatchObject({ sensitive: true, parameters: ['[redacted]', '[redacted]'] });
      expect(tester!.assertRecorded('request', (request) => request.route === 'login').content.input).toEqual({ email: 'ada@example.com', password: '[redacted]', _token: '[redacted]' });
      const all = JSON.stringify(tester!.entries());
      expect(all).not.toMatch(/hunter2|csrf-value|argon2id/);
    } finally {
      await app.shutdown();
    }
  });

  it('mails with the tokens and signatures in their links masked — and the token path of the request', async () => {
    const { app, tester, kernel } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      // Fixed, not random: 32 random bytes as the app makes them — this one without a digit; redact.test.ts covers the
      // random ones.
      const token = 'xcTSGsRRdFsBwbUDGMbH_yNyUBMgdklqlolrXjzXiiI';
      await kernel.request(`/reset-password/${token}`);
      const mail = tester!.assertRecorded('mail', (content) => content.subject === 'Reset your password');
      expect(mail.content).toMatchObject({ mailable: 'ResetMail', mode: 'send', to: ['ada@example.com'] });
      expect(mail.content.html).toContain('/reset-password/[redacted]?email=ada%40example.com');
      expect(mail.content.html).toContain('signature=[redacted]');
      expect(tester!.assertRecorded('request', (request) => request.route === 'password.reset').content.path).toBe('/reset-password/[redacted]');
      const all = JSON.stringify(tester!.entries());
      expect(all).not.toContain(token);
      expect(all).not.toContain('a1b2c3d4e5f6');
    } finally {
      await app.shutdown();
    }
  });

  it('an exception with its message redacted and its solutions, in the request batch', async () => {
    const { app, tester, kernel } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      const response = await kernel.request('/fail');
      expect(response.status).toBe(500);
      await tester!.settled();
      const exception = tester!.assertRecorded('exception');
      expect(exception.content).toMatchObject({ class: 'Error', in: 'request', status: 500, method: 'GET', path: '/fail' });
      expect(exception.content.message).toBe(`The report failed, password=[redacted] with marmeon_7|[redacted]`);
      expect(Array.isArray(exception.content.solutions)).toBe(true);
      expect(tester!.assertRecorded('request', (request) => request.path === '/fail').batch).toBe(exception.batch);
    } finally {
      await app.shutdown();
    }
  });

  it('cuts an entry at 64 KB', async () => {
    const { app, tester } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      // Each string alone is within 64 KB (strings are cut there anyway) — together they are not.
      app.container.make(Logger).info('big', { one: 'y'.repeat(50_000), two: 'z'.repeat(50_000), three: 'w'.repeat(50_000) });
      await tester!.settled();
      const log = tester!.assertRecorded('log', (content) => content.message === 'big');
      expect(Buffer.byteLength(JSON.stringify(log))).toBeLessThan(66 * 1024);
    } finally {
      await app.shutdown();
    }
  });

  it('records queries inside an SQLite transaction without ever using the database itself', async () => {
    const { app, tester, kernel } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      const response = await kernel.request('/transaction');
      expect(response.status).toBe(200);
      expect(tester!.entries('query').map((query) => query.content.sql)).toEqual(expect.arrayContaining([expect.stringContaining('insert into people'), 'select count(*) from people']));
    } finally {
      await app.shutdown();
    }
  });

  it('leaves out ignored paths with everything they did, and queries the app does not want', async () => {
    const config = `import { defineDevtools } from '${pathToFileURL(join(import.meta.dirname, 'index.ts')).href}';\nexport default defineDevtools({ ignore: { paths: ['/ignored'], queries: (query) => query.sql.includes('count(*)') } });\n`;
    const { app, kernel } = await boot({ NODE_ENV: 'development' }, { config });
    try {
      const store = app.container.make(DevtoolsStore);
      await kernel.request('/ignored');
      await kernel.request('/people/3');
      await app.container.make(Recorder).settled();
      const requests = await store.list({ type: 'request' });
      expect(requests.map((entry) => (entry.type === 'request' ? entry.content.path : ''))).toEqual(['/people/3']);
      const queries = await store.list({ type: 'query' });
      expect(queries.some((entry) => entry.type === 'query' && entry.content.sql.includes('count(*)'))).toBe(false);
    } finally {
      await app.shutdown();
    }
  });

  it('records events a test fake holds back — the fake keeps its slot', async () => {
    const fake: { value?: EventFake } = {};
    const { app, tester } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      fake.value = new EventFake(app.container.make(EventRegistry), 'all');
      const dispatcher = new EventDispatcher(app.container.make(EventRegistry), app.container, { app, observer: fake.value });
      await dispatcher.dispatch(new PersonViewed(1, 'x'));
      fake.value.assertDispatched(PersonViewed);
      await tester!.settled();
      tester!.assertRecorded('event', (event) => event.name === 'people.viewed');
    } finally {
      await app.shutdown();
    }
  });

  it('keeps a command as one batch — its arguments redacted', async () => {
    const { app, tester } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      const commands = channels.tracing('command.run');
      await trace(commands, { ...messageBase(app), command: 'users:import', args: ['--password=hunter2', 'file.csv'] }, async () => {
        app.container.make(Logger).info('Imported 3 users');
        await sql`select 1`.execute(app.container.make(Connections).get());
        return 0;
      }, (ended, code) => {
        ended.exitCode = code;
      });
      await tester!.settled();
      const command = tester!.assertRecorded('command');
      expect(command.content).toMatchObject({ command: 'users:import', args: ['--password=[redacted]', 'file.csv'], exitCode: 0 });
      expect(tester!.batch(command.batch).map((entry) => entry.type).sort()).toEqual(['command', 'log', 'query']);
    } finally {
      await app.shutdown();
    }
  });

  it('masks password hashes and API tokens by their pattern — where no key or secret column gives them away', async () => {
    const { app, tester } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      await trace(channels.tracing('command.run'), { ...messageBase(app), command: 'tokens:check', args: [] }, async () => {
        await sql`select ${HASH} as h, ${`token ${API_TOKEN}`} as t`.execute(app.container.make(Connections).get());
        app.container.make(Logger).info(`Checked ${API_TOKEN} against ${HASH}`);
        return 0;
      });
      await tester!.settled();
      expect(tester!.assertRecorded('query', (query) => query.sql.startsWith('select ? as h')).content).toMatchObject({ sensitive: false, parameters: ['[redacted]', 'token marmeon_7|[redacted]'] });
      expect(tester!.assertRecorded('log', (log) => log.message.startsWith('Checked')).content.message).toBe('Checked marmeon_7|[redacted] against [redacted]');
    } finally {
      await app.shutdown();
    }
  });

  it('does not record queries outside of a request, job, run or command — a worker polling its queue', async () => {
    const { app, tester } = await boot({ NODE_ENV: 'test' }, { test: true });
    try {
      await sql`select 42`.execute(app.container.make(Connections).get());
      app.container.make(Logger).warn('Outside of everything');
      await tester!.settled();
      expect(tester!.entries('query')).toEqual([]);
      tester!.assertRecorded('log', (log) => log.message === 'Outside of everything');
    } finally {
      await app.shutdown();
    }
  });
});
