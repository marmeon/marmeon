import type { Application, LogContextSources, Redactor } from '@bespokecore/core';
import { channels, type ChannelMessage, type DbQueryMessage, type HttpRequestMessage, type QueueDispatchMessage, type QueueJobMessage, type TracingName } from '@bespokecore/core/diagnostics';
import type { Attributes, Context, Span, SpanKind, SpanOptions } from '@opentelemetry/api';
import type { OtelApi } from './api.ts';

/** What the instrumentation needs besides the API. */
export interface InstrumentOptions {
  /** The app's redactor (E125): every attribute that may hold a secret goes through it — the same one as the error page's. */
  readonly redactor: Redactor;
  /** The app's log context sources — `trace_id` and `span_id` are added to each log entry written inside a span. */
  readonly logContext?: LogContextSources;
  /** Request headers recorded as `http.request.header.<name>` (lower case), their values redacted. */
  readonly requestHeaders?: readonly string[];
  /** The tracer's name (default `@bespokecore/otel`). */
  readonly tracerName?: string;
}

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const OPERATION = /^\s*\(?\s*(select|insert|update|delete|with|create|drop|alter|truncate|begin|commit|rollback|savepoint|release|pragma|explain)\b/i;
const TARGET = /\b(?:from|into|update|table(?: if (?:not )?exists)?)\s+(?:"([^"]+)"|`([^`]+)`|([\w.]+))/gi;
const DB_SYSTEMS: Readonly<Record<string, string>> = { sqlite: 'sqlite', pgsql: 'postgresql' };
const MESSAGING_SYSTEM = 'bespokecore';

/** The W3C `traceparent` of a span's context (`00-<trace id>-<span id>-<flags>`). */
export function traceparentOf(span: Span): string {
  const { traceId, spanId, traceFlags } = span.spanContext();
  return `00-${traceId}-${spanId}-${(traceFlags & 0xff).toString(16).padStart(2, '0')}`;
}

/**
 * Turns `app`'s channels (E118) into spans (E120), following OpenTelemetry's semantic conventions — `{method} {route}` server
 * spans with `http.route` and `http.response.status_code`, `db.query.text` without parameters, messaging spans for jobs —
 * and puts each operation's work into its span's context (`channels.around`), so what happens inside (queries, dispatches,
 * log lines, the app's own spans) is its child. Returns `off`.
 */
export function instrument(app: Application, api: OtelApi, options: InstrumentOptions): () => void {
  const { redactor } = options;
  const tracer = api.trace.getTracer(options.tracerName ?? '@bespokecore/otel');
  const requestHeaders = (options.requestHeaders ?? []).map((name) => name.toLowerCase()).filter(Boolean);
  /** The span of each operation in flight — set in `start`, used by the operation's wrapper and its `end`. */
  const spans = new WeakMap<object, Span>();
  /** Spans whose `error.type` an exception set already. */
  const typed = new WeakSet<Span>();
  const offs: (() => void)[] = [];

  const start = (message: object, name: string, kind: SpanKind, attributes: Attributes, parent: Context = api.context.active(), extra: SpanOptions = {}): Span => {
    const span = tracer.startSpan(name, { kind, startTime: (message as { startedAt: number }).startedAt, attributes: clean(attributes), ...extra }, parent);
    spans.set(message, span);
    return span;
  };
  const failed = (span: Span, error: unknown) => {
    span.recordException(exceptionOf(error, redactor));
    span.setAttribute('error.type', errorType(error));
    typed.add(span);
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: redactor.text(error instanceof Error ? error.message : String(error)) });
  };
  /** Ends the span of `message` — after `finish` set what the end knows. */
  const ender =
    <M extends object>(finish?: (span: Span, message: M) => void) =>
    (message: M) => {
      const span = spans.get(message);
      if (!span) return;
      spans.delete(message);
      finish?.(span, message);
      const error = (message as { error?: unknown }).error;
      if (error !== undefined && !typed.has(span)) failed(span, error);
      span.end();
    };
  /** Every traced operation's work runs in its span's context. */
  const wrap = (name: Exclude<TracingName, 'db.query'>) =>
    offs.push(
      channels.around(app, name, (message: object, run) => {
        const span = spans.get(message);
        if (span) api.context.with(api.trace.setSpan(api.context.active(), span), run);
        else run();
      }),
    );

  // ---- http.request: a server span per request; an in-process one (an island, a layer's base) is an internal child ----
  offs.push(
    channels.subscribe(app, 'http.request', {
      start: (request) => {
        const url = parseUrl(request.url);
        const parent = request.inProcess ? api.context.active() : api.propagation.extract(api.context.active(), request.headers, HEADER_GETTER);
        const method = KNOWN_METHODS.has(request.method) ? request.method : '_OTHER';
        start(request, method === '_OTHER' ? 'HTTP' : method, request.inProcess ? api.SpanKind.INTERNAL : api.SpanKind.SERVER, {
          'http.request.method': method,
          'http.request.method_original': method === '_OTHER' ? request.method : undefined,
          'url.scheme': url?.protocol.replace(/:$/, ''),
          'server.address': url?.hostname,
          'server.port': url?.port ? Number(url.port) : undefined,
          'user_agent.original': nonEmpty(request.headers.get('user-agent'), (value) => redactor.text(value)),
          'bespoke.request.id': request.requestId,
          'bespoke.region': request.region,
          ...capturedHeaders(request, requestHeaders, redactor),
        }, parent);
      },
      end: ender<HttpRequestMessage>((span, request) => {
        const url = parseUrl(request.url);
        const status = request.status ?? 500;
        const method = KNOWN_METHODS.has(request.method) ? request.method : 'HTTP';
        if (request.routePath !== undefined) span.updateName(`${method} ${request.routePath}`);
        span.setAttributes(
          clean({
            'http.route': request.routePath,
            'http.response.status_code': status,
            'url.path': redactedPath(request.path, request.routePath, redactor),
            'url.query': url && url.search.length > 1 ? redactor.text(url.search.slice(1)) : undefined,
            'bespoke.route.name': request.route,
            'bespoke.controller': request.controller,
          }),
        );
        // A server's 4xx is the client's mistake: the span stays unset (semantic conventions). Only a 5xx is an error.
        if (status >= 500) {
          if (!typed.has(span)) span.setAttribute('error.type', String(status));
          span.setStatus({ code: api.SpanStatusCode.ERROR });
        }
      }),
    }),
  );
  wrap('http.request');

  // ---- exception: the error a request ended in, on the request's span (a 5xx only) ----
  offs.push(
    channels.subscribe(app, 'exception', (exception) => {
      if (exception.status < 500) return;
      const span = api.trace.getSpan(api.context.active());
      if (!span?.isRecording()) return;
      span.recordException(exceptionOf(exception.error, redactor));
      span.setAttribute('error.type', errorType(exception.error));
      typed.add(span);
    }),
  );

  // ---- db.query: a client span, published once the statement ran — the request's or job's span is its parent ----
  offs.push(
    channels.subscribe(app, 'db.query', {
      end: (query: DbQueryMessage) => {
        const parent = api.context.active();
        // A statement outside of every traced operation (a health check, a CLI command) would be a trace of its own: none.
        const outer = api.trace.getSpan(parent);
        if (!outer || !api.isSpanContextValid(outer.spanContext())) return;
        const operation = OPERATION.exec(query.sql)?.[1]?.toUpperCase();
        const table = collectionOf(query.sql);
        const system = DB_SYSTEMS[query.driver] ?? query.driver;
        const span = tracer.startSpan(
          operation ? `${operation}${table && operation !== 'WITH' ? ` ${table}` : ''}` : system,
          {
            kind: api.SpanKind.CLIENT,
            startTime: query.startedAt,
            attributes: clean({
              'db.system.name': system,
              // The statement only — its parameters never (E125): Kysely binds every value, so the text holds placeholders.
              'db.query.text': redactor.text(query.sql),
              'db.operation.name': operation,
              'db.collection.name': table,
              'bespoke.db.connection': query.connection,
            }),
          },
          parent,
        );
        if (query.error !== undefined) failed(span, query.error);
        span.end(query.startedAt + query.durationMs);
      },
    }),
  );

  // ---- queue.dispatch: a producer span; its context goes with the job (E131) ----
  offs.push(
    channels.subscribe(app, 'queue.dispatch', {
      start: (dispatch: QueueDispatchMessage) => {
        const span = start(dispatch, dispatch.jobs.length === 1 ? `send ${dispatch.jobs[0]}` : `send ${dispatch.queue}`, api.SpanKind.PRODUCER, {
          'messaging.system': MESSAGING_SYSTEM,
          'messaging.operation.type': 'send',
          'messaging.operation.name': dispatch.kind,
          'messaging.destination.name': dispatch.queue,
          'messaging.batch.message_count': dispatch.jobs.length > 1 ? dispatch.jobs.length : undefined,
          'bespoke.queue.connection': dispatch.connection,
          'bespoke.queue.jobs': [...dispatch.jobs],
          'bespoke.queue.delay': dispatch.delay > 0 ? dispatch.delay : undefined,
        });
        if (api.isSpanContextValid(span.spanContext())) dispatch.traceparent = traceparentOf(span);
      },
      end: ender<QueueDispatchMessage>((span, dispatch) => {
        if (dispatch.jobIds.length === 1) span.setAttribute('messaging.message.id', dispatch.jobIds[0]!);
      }),
    }),
  );
  wrap('queue.dispatch');

  // ---- queue.job: a consumer span in the trace of whoever dispatched it — a request's, a task's, another job's ----
  offs.push(
    channels.subscribe(app, 'queue.job', {
      start: (job: QueueJobMessage) => {
        const dispatched = job.traceparent === undefined ? undefined : remoteContext(api, job.traceparent);
        start(
          job,
          `process ${job.job}`,
          api.SpanKind.CONSUMER,
          {
            'messaging.system': MESSAGING_SYSTEM,
            'messaging.operation.type': 'process',
            'messaging.destination.name': job.queue,
            'messaging.message.id': job.jobId,
            'bespoke.job': job.job,
            'bespoke.job.attempt': job.attempt,
            'bespoke.queue.connection': job.connection,
            'bespoke.request.origin_id': job.originRequestId,
          },
          dispatched ?? api.context.active(),
        );
      },
      end: ender<QueueJobMessage>((span, job) => {
        if (job.outcome !== undefined) span.setAttribute('bespoke.job.outcome', job.outcome);
        if (job.outcome === 'failed' && job.error === undefined) span.setStatus({ code: api.SpanStatusCode.ERROR });
      }),
    }),
  );
  wrap('queue.job');

  // ---- the other operations: internal (mail: client) spans ----
  const simple = <N extends 'schedule.task' | 'mail.send' | 'notification.send' | 'live.refresh' | 'render.ssr'>(
    name: N,
    kind: SpanKind,
    describe: (message: ChannelMessage<N>) => { name: string; attributes: Attributes },
    finish?: (span: Span, message: ChannelMessage<N>) => void,
  ) => {
    offs.push(
      channels.subscribe(app, name, {
        start: (message: ChannelMessage<N>) => {
          const { name: spanName, attributes } = describe(message);
          start(message, spanName, kind, attributes);
        },
        end: ender<ChannelMessage<N>>(finish),
      } as never),
    );
    wrap(name);
  };

  simple(
    'schedule.task',
    api.SpanKind.INTERNAL,
    (task) => ({ name: `schedule ${task.task}`, attributes: { 'bespoke.schedule.task': task.task, 'bespoke.schedule.reason': task.reason } }),
    (span, task) => {
      span.setAttributes(clean({ 'bespoke.schedule.outcome': task.outcome, 'bespoke.schedule.skipped': task.skipped }));
      if (task.outcome === 'failed' && task.error === undefined) span.setStatus({ code: api.SpanStatusCode.ERROR });
    },
  );
  // Mails: which mailable, how; recipients only counted — addresses and subjects are personal data.
  simple(
    'mail.send',
    api.SpanKind.CLIENT,
    (mail) => ({ name: `mail ${mail.mailable}`, attributes: { 'bespoke.mail.mailable': mail.mailable, 'bespoke.mail.mode': mail.mode } }),
    (span, mail) => {
      if (mail.to !== undefined) span.setAttribute('bespoke.mail.recipients', mail.to.length);
    },
  );
  simple(
    'notification.send',
    api.SpanKind.INTERNAL,
    (notification) => ({
      name: `notify ${notification.notification}`,
      attributes: { 'bespoke.notification': notification.notification, 'bespoke.notification.queued': notification.queued, 'bespoke.notification.recipient_type': notification.recipient.type },
    }),
    (span, notification) => {
      span.setAttributes(clean({ 'bespoke.notification.channels': notification.channels ? [...notification.channels] : undefined, 'bespoke.notification.outcome': notification.outcome }));
    },
  );
  simple('live.refresh', api.SpanKind.PRODUCER, (refresh) => ({
    name: 'live refresh',
    attributes: { 'bespoke.live.channel': refresh.channel, 'bespoke.live.only': refresh.only ? [...refresh.only] : undefined },
  }));
  simple(
    'render.ssr',
    api.SpanKind.INTERNAL,
    (render) => ({ name: `render ${render.component}`, attributes: { 'bespoke.view': render.component, 'bespoke.ssr.complete': render.complete } }),
    (span, render) => {
      if (render.streamed !== undefined) span.setAttribute('bespoke.ssr.streamed', render.streamed);
    },
  );

  // ---- the log: each entry written inside a span carries its ids ----
  if (options.logContext) {
    offs.push(
      options.logContext.add(() => {
        const span = api.trace.getSpan(api.context.active());
        if (!span) return undefined;
        const context = span.spanContext();
        if (!api.isSpanContextValid(context)) return undefined;
        return { trace_id: context.traceId, span_id: context.spanId, trace_flags: (context.traceFlags & 0xff).toString(16).padStart(2, '0') };
      }),
    );
  }

  return () => {
    for (const off of offs.splice(0)) off();
  };
}

const HEADER_GETTER = {
  keys: (headers: Headers) => [...headers.keys()],
  get: (headers: Headers, key: string) => headers.get(key) ?? undefined,
};

/** The context of a dispatch, from the `traceparent` stored with the job — a remote parent. */
function remoteContext(api: OtelApi, traceparent: string): Context | undefined {
  const match = TRACEPARENT.exec(traceparent);
  if (!match) return undefined;
  const spanContext = { traceId: match[1]!, spanId: match[2]!, traceFlags: Number.parseInt(match[3]!, 16), isRemote: true };
  if (!api.isSpanContextValid(spanContext)) return undefined;
  return api.trace.setSpanContext(api.ROOT_CONTEXT, spanContext);
}

/** The one table a statement names (`from`, `into`, `update`) — none when it names several (a subquery): the name would guess. */
function collectionOf(sql: string): string | undefined {
  const tables = new Set<string>();
  for (const match of sql.matchAll(TARGET)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined && name !== '(' && !/^select$/i.test(name)) tables.add(name);
  }
  return tables.size === 1 ? [...tables][0] : undefined;
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * The path as requested, with the values of sensitive route parameters (`/reset/:token`) replaced — names the redactor knows
 * (E125); the rest of the path through the redactor's text rules.
 */
export function redactedPath(path: string, pattern: string | undefined, redactor: Redactor): string {
  return redactor.path(path, pattern);
}

function capturedHeaders(request: HttpRequestMessage, names: readonly string[], redactor: Redactor): Attributes {
  if (names.length === 0) return {};
  const shown = redactor.headers(names.flatMap((name) => (request.headers.has(name) ? [[name, request.headers.get(name)!] as const] : [])));
  return Object.fromEntries(Object.entries(shown).map(([name, value]) => [`http.request.header.${name}`, [value]]));
}

function nonEmpty(value: string | null | undefined, map: (value: string) => string): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : map(value);
}

/** The attributes without `undefined` values (OpenTelemetry drops them, but warns). */
function clean(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined) out[key] = value;
  return out;
}

/** `error.type`: the error's class name (or its code), for anything thrown. */
function errorType(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return error.constructor?.name && error.constructor.name !== 'Error' ? error.constructor.name : typeof code === 'string' ? code : error.name;
  }
  return typeof error;
}

/** The exception event of a span — its message and stack redacted like a log entry's (E125). */
function exceptionOf(error: unknown, redactor: Redactor): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: errorType(error), message: redactor.text(error.message), ...(error.stack ? { stack: redactor.text(error.stack) } : {}) };
  return { name: typeof error, message: redactor.text(String(error)) };
}
