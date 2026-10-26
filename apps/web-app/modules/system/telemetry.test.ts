import { Writable } from 'node:stream';
import { Application, Logger } from '@marmeon/core';
import { createPinoLogger } from '@marmeon/log';
import { createTestApp } from '@marmeon/testing';
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUp } from '../auth/warm-up.ts';

// Cold starts in a hook with its own time, not in the first test's 5 s (the worker's database, the queues, mjml, the mails).
beforeAll(warmUp, WARM_UP_TIMEOUT);

// What bootstrap/telemetry.ts registers — with an in-memory exporter instead of OTLP.
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

const dump = (span: ReadableSpan) => JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events, status: span.status });
const parentOf = (span: ReadableSpan | undefined) => span?.parentSpanContext?.spanId;

describe('OpenTelemetry in the web app', () => {
  it('a registration: `POST /register` with its queries (no parameters), the welcome job in the same trace, its mail; trace ids in the log', async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(JSON.parse(String(chunk)));
        done();
      },
    });
    const app = await createTestApp(application, {
      database: 'refresh',
      mail: 'real',
      override: (container) => container.instance(Logger, createPinoLogger({ level: 'info', format: 'json' }, { destination: stream, app: container.make(Application) })),
    });
    exporter.reset();
    const password = 'correct horse battery staple';
    await app
      .post('/register', { form: { name: 'Ada Lovelace', email: 'ada@example.com', password, password_confirmation: password }, headers: { referer: 'http://localhost/register' } })
      .assertRedirect('/register/sent');
    await app.queue.work();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const request = spans.find((span) => span.name === 'POST /register')!;
    expect(request).toBeDefined();
    expect(request.kind).toBe(SpanKind.SERVER);
    expect(request.attributes).toMatchObject({ 'http.route': '/register', 'http.response.status_code': 303, 'marmeon.route.name': 'auth.register.store', 'marmeon.controller': 'RegisterController' });
    const traceId = request.spanContext().traceId;

    // The account's insert: a child of the request, without its parameters (the Argon2 hash, the e-mail address).
    const insert = spans.find((span) => String(span.attributes['db.query.text'] ?? '').startsWith('insert into "users"'))!;
    expect(insert.name).toBe('INSERT users');
    expect(parentOf(insert)).toBe(request.spanContext().spanId);

    // The welcome job ran in the request's trace (through the job's traceparent), its mail inside it.
    const job = spans.find((span) => span.name === 'process auth.send-welcome-mail')!;
    expect(job.spanContext().traceId).toBe(traceId);
    const mail = spans.find((span) => span.name === 'mail WelcomeMail')!;
    expect(parentOf(mail)).toBe(job.spanContext().spanId);
    expect(mail.attributes).toMatchObject({ 'marmeon.mail.mode': 'send', 'marmeon.mail.recipients': 1 });

    // Nothing secret in any span: the password, its hash, the address, the session.
    const everything = spans.map(dump).join('\n');
    expect(everything).not.toContain(password);
    expect(everything).not.toMatch(/\$argon2id\$/);
    expect(everything).not.toContain('ada@example.com');

    // The request's log line carries its trace.
    const logged = lines.find((line) => typeof line.msg === 'string' && line.msg.startsWith('POST /register 303'));
    expect(logged).toMatchObject({ trace_id: traceId, span_id: request.spanContext().spanId, route: 'auth.register.store' });
    await app.close();
  });

  it('/up and /up/ready leave no span — neither the endpoints nor the queries of their checks', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    exporter.reset();
    expect((await app.get('/up')).status).toBe(200);
    expect((await app.get('/up/ready')).status).toBe(200);
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toEqual([]);
    await app.close();
  });
});
