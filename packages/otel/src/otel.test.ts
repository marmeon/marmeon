import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Application, createApplication, defineModule, Logger, type ServiceProviderClass } from '@marmeon/core';
import { channels } from '@marmeon/core/diagnostics';
import { Connections, Database, DatabaseServiceProvider, Schema, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { abort, HttpServiceProvider } from '@marmeon/http';
import { createPinoLogger } from '@marmeon/log';
import { Queue, QueueConnections, QueueServiceProvider, type JobContext } from '@marmeon/queue';
import { QUEUE_MIGRATION } from '@marmeon/queue/internal';
import type { HttpContext } from '@marmeon/router';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOtelApi } from './api.ts';
import { OtelServiceProvider } from './index.ts';
import { redactedPath } from './tracer.ts';
import { ErrorSolutions, Redactor } from '@marmeon/core';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { openRoutes } from './test-helpers/open-routes.ts';

// The SDK, as an app's bootstrap/telemetry.ts would register it — with an in-memory exporter (SDK 3 names: `TracerProvider`).
const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
});
afterAll(() => {
  trace.disable();
  context.disable();
  propagation.disable();
});

const root = tempDir('marmeon-otel-');

class ReportJob {
  static readonly job = 'test.report';
  static readonly schema = v.object({ userId: v.number() });
  readonly #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }
  async handle(payload: { userId: number }) {
    await sql`select count(*) as n from people where id = ${payload.userId}`.execute(this.#db);
  }
}

/** Fails through its context — without throwing. */
class RefusedJob {
  static readonly job = 'test.refused';
  static readonly schema = v.object({});
  handle(_payload: object, job: JobContext) {
    job.fail('the account is gone');
  }
}

/** What the controller saw as the active span — user code's own spans nest under the request's. */
const seen: { activeTraceId?: string } = {};

class ShowPersonController {
  readonly #db: Database;
  readonly #queue: Queue;
  readonly #logger: Logger;
  constructor(db: Database, queue: Queue, logger: Logger) {
    this.#db = db;
    this.#queue = queue;
    this.#logger = logger;
  }
  async handle(ctx: HttpContext<{}, { person: string }>) {
    seen.activeTraceId = trace.getActiveSpan()?.spanContext().traceId;
    // A parameter that must never reach a span.
    const rows = await this.#db.selectFrom('people' as never).selectAll().where('email' as never, '=', 'ada-secret@example.com' as never).execute();
    await this.#queue.dispatch(ReportJob, { userId: Number(ctx.params.person) });
    this.#logger.info('Looked at a person', { found: rows.length });
    return { id: Number(ctx.params.person) };
  }
}

const routes = openRoutes((Route) => {
  Route.get('/people/:person', ShowPersonController).name('people.show');
  Route.get('/fail', () => {
    throw new Error('The report failed, token=tok-123');
  });
  Route.get('/missing', () => abort(404));
  Route.get('/reset/:token', () => ({ ok: true }));
});

function boot(env: Record<string, string> = {}, providers: ServiceProviderClass[] = [OtelServiceProvider]) {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  const app = createApplication({
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, DatabaseServiceProvider, QueueServiceProvider, ...providers],
    modules: [defineModule({ name: 'people', routes, jobs: [ReportJob, RefusedJob] })],
  }, { env: { APP_KEY: generateKey(), DB_CONNECTION: 'sqlite', DB_DATABASE: join(root, `${crypto.randomUUID()}.sqlite`), QUEUE_CONNECTION: 'database', ...env }, override: (container) => container.instance(Logger, createPinoLogger({ level: 'info', format: 'json' }, stream, container.make(Application))) }).then(async (application) => {
    const connections = application.container.make(Connections);
    const schema = new Schema(connections.get(), 'sqlite');
    const migration = ((await import(QUEUE_MIGRATION.href)) as { default: { up(schema: Schema): Promise<void> } }).default;
    await migration.up(schema);
    await schema.create('people', (table) => {
      table.id();
      table.string('email');
    });
    return application;
  });
  return { app, lines };
}

/** The spans exported so far — and forgets them. */
async function spans(): Promise<ReadableSpan[]> {
  await provider.forceFlush();
  const finished = [...exporter.getFinishedSpans()];
  exporter.reset();
  return finished;
}

/** What a span exports: its name, attributes, events, status and links. */
const dump = (span: ReadableSpan | undefined) => JSON.stringify(span && { name: span.name, attributes: span.attributes, events: span.events, status: span.status, links: span.links });
const byName = (list: readonly ReadableSpan[], name: string) => list.find((span) => span.name === name);
const parentOf = (span: ReadableSpan | undefined) => span?.parentSpanContext?.spanId;

describe('@marmeon/otel', () => {
  it('a request: a server span `GET /people/:person`, its query (without parameters), the dispatch — and the job, run by the worker, in the same trace', async () => {
    const { app: booting, lines } = boot();
    await using app = await booting;
    await spans();
    const kernel = createHttpKernel(app);
    const response = await kernel.request('http://shop.test/people/7?page=2&token=secret-in-the-url', { headers: { 'user-agent': 'probe/1.0' } });
    expect(response.status).toBe(200);
    // The worker, as `marmeon queue:work` runs it: the job comes out of the jobs table, its trace context with it.
    await app.container.make(QueueConnections).worker('database', 10).run({ queues: ['default'], stopWhenEmpty: true });

    const all = await spans();
    const request = byName(all, 'GET /people/:person')!;
    expect(request).toBeDefined();
    expect(request.kind).toBe(SpanKind.SERVER);
    expect(request.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/people/:person',
      'http.response.status_code': 200,
      'url.path': '/people/7',
      'url.scheme': 'http',
      'server.address': 'shop.test',
      'user_agent.original': 'probe/1.0',
      'marmeon.route.name': 'people.show',
      'marmeon.controller': 'ShowPersonController',
    });
    // Only the keys of the query leave the process by default (OTEL_RECORD_QUERY_VALUES=true records the values).
    expect(request.attributes['url.query']).toBe('page=&token=');
    expect(request.attributes['marmeon.request.id']).toBe(response.headers.get('x-request-id'));
    expect(request.status.code).toBe(SpanStatusCode.UNSET);
    const traceId = request.spanContext().traceId;
    expect(seen.activeTraceId).toBe(traceId);

    // The query: a child of the request, its text with placeholders — the parameter nowhere.
    const query = all.find((span) => span.attributes['db.query.text'] !== undefined && String(span.attributes['db.query.text']).includes('"people"') && span.spanContext().traceId === traceId && parentOf(span) === request.spanContext().spanId);
    expect(query).toBeDefined();
    expect(query!.name).toBe('SELECT people');
    expect(query!.kind).toBe(SpanKind.CLIENT);
    expect(query!.attributes).toMatchObject({ 'db.system.name': 'sqlite', 'db.operation.name': 'SELECT', 'db.collection.name': 'people', 'marmeon.db.connection': 'default' });
    expect(query!.attributes['db.query.text']).toBe('select * from "people" where "email" = ?');
    expect(all.map(dump).join('\n')).not.toContain('ada-secret@example.com');

    // The dispatch is the request's child; the job runs in the same trace, under the dispatch.
    const send = byName(all, 'send test.report')!;
    expect(send).toMatchObject({ kind: SpanKind.PRODUCER });
    expect(parentOf(send)).toBe(request.spanContext().spanId);
    expect(send.attributes).toMatchObject({ 'messaging.system': 'marmeon', 'messaging.operation.type': 'send', 'messaging.destination.name': 'default' });
    const job = byName(all, 'process test.report')!;
    expect(job.kind).toBe(SpanKind.CONSUMER);
    expect(job.spanContext().traceId).toBe(traceId);
    expect(parentOf(job)).toBe(send.spanContext().spanId);
    expect(job.attributes).toMatchObject({ 'marmeon.job': 'test.report', 'marmeon.job.attempt': 1, 'marmeon.job.outcome': 'done', 'marmeon.request.origin_id': response.headers.get('x-request-id') });
    // The job's own query is the job's child.
    const jobQuery = all.find((span) => parentOf(span) === job.spanContext().spanId && span.attributes['db.system.name'] === 'sqlite');
    expect(jobQuery?.attributes['db.query.text']).toBe('select count(*) as n from people where id = ?');

    // The log lines of the request — its own and the controller's — carry the trace's ids.
    const logged = lines.find((line) => line.msg === 'Looked at a person');
    expect(logged).toMatchObject({ trace_id: traceId, trace_flags: '01' });
    const requestLine = lines.find((line) => typeof line.msg === 'string' && line.msg.startsWith('GET /people/7 200'));
    expect(requestLine).toMatchObject({ trace_id: traceId, span_id: request.spanContext().spanId });
  });

  it('a 5xx is an error with `error.type` and the exception (redacted); a 4xx is not an error', async () => {
    const { app: booting } = boot();
    await using app = await booting;
    await spans();
    const kernel = createHttpKernel(app);
    expect((await kernel.request('/fail', { headers: { accept: 'application/json' } })).status).toBe(500);
    expect((await kernel.request('/missing', { headers: { accept: 'application/json' } })).status).toBe(404);
    const all = await spans();
    const failed = all.find((span) => span.attributes['url.path'] === '/fail')!;
    expect(failed.name).toBe('GET /fail');
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.attributes['error.type']).toBe('Error');
    expect(failed.attributes['http.response.status_code']).toBe(500);
    const exception = failed.events.find((event) => event.name === 'exception')!;
    expect(exception.attributes?.['exception.message']).toBe('The report failed, token=[redacted]');
    expect(dump(failed)).not.toContain('tok-123');
    const missing = all.find((span) => span.attributes['url.path'] === '/missing')!;
    expect(missing.status.code).toBe(SpanStatusCode.UNSET);
    expect(missing.attributes['error.type']).toBeUndefined();
    expect(missing.events).toEqual([]);
  });

  it('a job that fails without throwing is an error too: the error status and `error.type` _OTHER, no exception event', async () => {
    const { app: booting } = boot();
    await using app = await booting;
    await app.container.make(Queue).dispatch(RefusedJob, {});
    await spans();
    await app.container.make(QueueConnections).worker('database', 10).run({ queues: ['default'], stopWhenEmpty: true });
    const job = byName(await spans(), 'process test.refused')!;
    expect(job.attributes['marmeon.job.outcome']).toBe('failed');
    expect(job.status.code).toBe(SpanStatusCode.ERROR);
    expect(job.attributes['error.type']).toBe('_OTHER');
    expect(job.events).toEqual([]);
  });

  it("starts a trace of its own for every request — a caller's traceparent is a link, never the parent", async () => {
    const { app: booting } = boot();
    await using app = await booting;
    await spans();
    const kernel = createHttpKernel(app);
    const caller = '0af7651916cd43dd8448eb211c80319c';
    // The caller says "not sampled" (flags 00): its word decides nothing here — the request is recorded, in a trace of its own.
    await kernel.request('/people/1', { headers: { traceparent: `00-${caller}-b7ad6b7169203331-00` } });
    const all = await spans();
    const server = all.find((candidate) => candidate.kind === SpanKind.SERVER);
    expect(server, 'the request was not recorded: the caller\'s sampled flag decided').toBeDefined();
    expect(server!.spanContext().traceId).not.toBe(caller);
    expect(parentOf(server)).toBeUndefined();
    expect(server!.links.map((link) => [link.context.traceId, link.context.spanId])).toEqual([[caller, 'b7ad6b7169203331']]);
    // What happens inside is still the request's child — its own trace.
    expect(all.filter((span) => span.kind !== SpanKind.SERVER && span.kind !== SpanKind.CONSUMER).every((span) => span.spanContext().traceId === server!.spanContext().traceId)).toBe(true);
    // No header, or a broken one: a new trace, no link.
    await kernel.request('/people/1', { headers: { traceparent: 'not-a-traceparent' } });
    const [plain] = (await spans()).filter((candidate) => candidate.kind === SpanKind.SERVER);
    expect(plain!.links).toEqual([]);
    expect(parentOf(plain)).toBeUndefined();
  });

  it('continues an incoming trace with OTEL_TRUST_TRACEPARENT=true (behind an edge that sets the header); redacts sensitive route parameters and recorded headers', async () => {
    const { app: booting } = boot({ OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST: 'authorization, x-tenant, cookie', OTEL_TRUST_TRACEPARENT: 'true' });
    await using app = await booting;
    await spans();
    const kernel = createHttpKernel(app);
    const caller = '0af7651916cd43dd8448eb211c80319c';
    await kernel.request('/reset/a-reset-token-value', {
      headers: { traceparent: `00-${caller}-b7ad6b7169203331-01`, authorization: 'Bearer secret-api-token', 'x-tenant': 'acme', cookie: 'marmeon_session=abc' },
    });
    const [span] = (await spans()).filter((candidate) => candidate.kind === SpanKind.SERVER);
    expect(span!.spanContext().traceId).toBe(caller);
    expect(parentOf(span)).toBe('b7ad6b7169203331');
    expect(span!.links).toEqual([]);
    expect(span!.attributes['url.path']).toBe('/reset/[redacted]');
    expect(span!.attributes['http.request.header.authorization']).toEqual(['[redacted]']);
    expect(span!.attributes['http.request.header.cookie']).toEqual(['[redacted]']);
    expect(span!.attributes['http.request.header.x-tenant']).toEqual(['acme']);
    expect(dump(span)).not.toMatch(/secret-api-token|a-reset-token-value|session=abc/);
  });

  it('records the keys of the query only — its values with OTEL_RECORD_QUERY_VALUES=true, masked like any text', async () => {
    const query = (attributes: Record<string, unknown> | undefined) => String(attributes?.['url.query']);
    // A part without `=` may be a flag or a value (`?ada@example.com`): it is never written as it is.
    const url = 'http://shop.test/people/7?q=ada%40example.com&page=2&bare-ada%40example.com&token=secret-in-the-url&q=second';
    const { app: booting } = boot();
    await using app = await booting;
    await spans();
    await createHttpKernel(app).request(url);
    const [plain] = (await spans()).filter((candidate) => candidate.kind === SpanKind.SERVER);
    expect(query(plain?.attributes), dump(plain)).toBe('q=&page=&[redacted]&token=&q=');
    expect(dump(plain)).not.toMatch(/ada%40example|ada@example|bare|second|secret-in-the-url/);

    const { app: recording } = boot({ OTEL_RECORD_QUERY_VALUES: 'true' });
    await using withValues = await recording;
    await spans();
    await createHttpKernel(withValues).request(url);
    const [valued] = (await spans()).filter((candidate) => candidate.kind === SpanKind.SERVER);
    expect(query(valued?.attributes), dump(valued)).toBe('q=ada%40example.com&page=2&bare-ada%40example.com&token=[redacted]&q=second');
  });

  it('names the deployment on every span it records: deployment.environment.name is APP_ENV (by default the one NODE_ENV goes with)', async () => {
    const { app: booting } = boot({ NODE_ENV: 'production', APP_ENV: 'staging' });
    await using app = await booting;
    await spans();
    await createHttpKernel(app).request('http://shop.test/people/7');
    const all = await spans();
    expect(all.length).toBeGreaterThan(1);
    for (const span of all) expect(span.attributes['deployment.environment.name'], span.name).toBe('staging');
    const { app: plain } = boot({ NODE_ENV: 'test' });
    await using tested = await plain;
    await createHttpKernel(tested).request('http://shop.test/people/7');
    expect(byName(await spans(), 'GET /people/:person')!.attributes['deployment.environment.name']).toBe('testing');
  });

  it('stops on shutdown: no subscriber left, nothing built for the app any more', async () => {
    const { app: booting } = boot();
    const app = await booting;
    expect(channels.tracing('http.request').hasSubscribers).toBe(true);
    await app.shutdown();
    expect(channels.tracing('http.request').hasSubscribers).toBe(false);
    expect(channels.tracing('db.query').hasSubscribers).toBe(false);
    expect(channels.event('exception').hasSubscribers).toBe(false);
  });

  it('OTEL_SDK_DISABLED=true: nothing subscribed', async () => {
    const { app: booting } = boot({ OTEL_SDK_DISABLED: 'TRUE' });
    await using app = await booting;
    const before = channels.built(app);
    await createHttpKernel(app).request('/people/1');
    expect(channels.built(app)).toBe(before);
    expect(await spans()).toEqual([]);
  });

  it('without @opentelemetry/api: the start fails with what to install', async () => {
    const missing = Object.assign(new Error("Cannot find package '@opentelemetry/api' imported from …"), { code: 'ERR_MODULE_NOT_FOUND' });
    const error = await loadOtelApi(() => Promise.reject(missing)).catch((failure: unknown) => failure);
    // The range of the peer dependency, as package.json names it — not a looser one the package was never tested with.
    const peer = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { peerDependencies: Record<string, string> }).peerDependencies['@opentelemetry/api'];
    expect(peer).toBe('^1.9.0');
    expect((error as Error).message).toContain(`@marmeon/otel needs the OpenTelemetry API, which is not installed in this app: pnpm add @opentelemetry/api@${peer} `);
    // `marmeon` prints the way out when the app cannot start.
    const [solution] = await new ErrorSolutions(OtelServiceProvider.solutions).find(error);
    expect(solution).toMatchObject({ title: 'Install the OpenTelemetry API', command: `pnpm add @opentelemetry/api@${peer}` });
  });

  it('redactedPath: sensitive parameters by name; a pattern that does not line up shows the pattern', () => {
    const redactor = new Redactor();
    expect(redactedPath('/reset/abc', '/reset/:token', redactor)).toBe('/reset/[redacted]');
    expect(redactedPath('/users/7/links/9', '/users/:user/links/:link', redactor)).toBe('/users/7/links/9');
    expect(redactedPath('/files/a/b', '/files/:signature{.+}*', redactor)).toBe('/files/:signature{.+}*');
    expect(redactedPath('/login', undefined, redactor)).toBe('/login');
  });
});
