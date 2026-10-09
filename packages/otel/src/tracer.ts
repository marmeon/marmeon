import type { Application, LogContextSources, Redactor } from '@marmeon/core';
import { channels, type ChannelMessage, type DbQueryMessage, type HttpRequestMessage, type QueueDispatchMessage, type QueueJobMessage, type TracingName } from '@marmeon/core/diagnostics';
import type { Attributes, Context, Link, Span, SpanKind, SpanOptions } from '@opentelemetry/api';
import type { OtelApi } from './api.ts';

/** What the instrumentation needs besides the API. */
export interface InstrumentOptions {
  /** The app's redactor (E125): every attribute that may hold a secret goes through it — the same one as the error page's. */
  readonly redactor: Redactor;
  /** The app's log context sources — `trace_id` and `span_id` are added to each log entry written inside a span. */
  readonly logContext?: LogContextSources;
  /** Request headers recorded as `http.request.header.<name>` (lower case), their values redacted. */
  readonly requestHeaders?: readonly string[];
  /** The tracer's name (default `@marmeon/otel`). */
  readonly tracerName?: string;
  /**
   * Continue the trace of an incoming request's `traceparent` (and take its baggage) — `OTEL_TRUST_TRACEPARENT=true`. Off by default
   * (W10 step 8, Max 07.10.): anyone can send the header, so every request starts a trace of its own and the caller's context is
   * only a **link** of its server span — findable, but its trace id and its sampling decision are not taken. Turn it on only
   * where the edge in front of the app (a gateway, an ingress) sets or strips the header itself, or for an internal service
   * whose callers are your own. A trusted proxy is no such edge by itself: it usually passes the client's header on unchanged.
   */
  readonly trustTraceparent?: boolean;
  /**
   * `url.query` with its values — `OTEL_RECORD_QUERY_VALUES=true`, masked as text by the redactor. Off by default: a span records
   * only the keys (`q=&page=`), since a query carries e-mail addresses, search terms or a token under a harmless name.
   */
  readonly recordQueryValues?: boolean;
  /**
   * The app's environment (`APP_ENV`, E217): `deployment.environment.name` on every span the framework starts. The resource is the
   * SDK's — the app's `bootstrap/telemetry.ts` — so the framework says it per span; `OTEL_RESOURCE_ATTRIBUTES` puts it on the resource.
   */
  readonly environment?: string;
}

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const OPERATION = /^\s*\(?\s*(select|insert|update|delete|with|create|drop|alter|truncate|begin|commit|rollback|savepoint|release|pragma|explain)\b/i;
const TARGET = /\b(?:from|into|update|table(?: if (?:not )?exists)?)\s+(?:"([^"]+)"|`([^`]+)`|([\w.]+))/gi;
const DB_SYSTEMS: Readonly<Record<string, string>> = { sqlite: 'sqlite', pgsql: 'postgresql' };
const MESSAGING_SYSTEM = 'marmeon';

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
  const { redactor, recordQueryValues = false } = options;
  const tracer = api.trace.getTracer(options.tracerName ?? '@marmeon/otel');
  const requestHeaders = (options.requestHeaders ?? []).map((name) => name.toLowerCase()).filter(Boolean);
  /** The span of each operation in flight — set in `start`, used by the operation's wrapper and its `end`. */
  const spans = new WeakMap<object, Span>();
  /** Spans whose `error.type` an exception set already. */
  const typed = new WeakSet<Span>();
  const offs: (() => void)[] = [];

  const deployment: Attributes = options.environment === undefined ? {} : { 'deployment.environment.name': options.environment };
  const start = (message: object, name: string, kind: SpanKind, attributes: Attributes, parent: Context = api.context.active(), extra: SpanOptions = {}): Span => {
    const span = tracer.startSpan(name, { kind, startTime: (message as { startedAt: number }).startedAt, attributes: clean({ ...deployment, ...attributes }), ...extra }, parent);
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
  /**
   * Where a request from outside starts: the caller's trace when it is trusted (`trustTraceparent`); otherwise a new root — the
   * caller's valid `traceparent` a link only (its sampled flag decides nothing here), its baggage dropped.
   */
  const incoming = (headers: Headers): { parent: Context; links: Link[] | undefined } => {
    if (options.trustTraceparent) return { parent: api.propagation.extract(api.context.active(), headers, HEADER_GETTER), links: undefined };
    const caller = api.trace.getSpanContext(api.propagation.extract(api.ROOT_CONTEXT, headers, HEADER_GETTER));
    return { parent: api.trace.deleteSpan(api.context.active()), links: caller && api.isSpanContextValid(caller) ? [{ context: caller }] : undefined };
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
        const { parent, links } = request.inProcess ? { parent: api.context.active(), links: undefined } : incoming(request.headers);
        const method = KNOWN_METHODS.has(request.method) ? request.method : '_OTHER';
        start(request, method === '_OTHER' ? 'HTTP' : method, request.inProcess ? api.SpanKind.INTERNAL : api.SpanKind.SERVER, {
          'http.request.method': method,
          'http.request.method_original': method === '_OTHER' ? request.method : undefined,
          'url.scheme': url?.protocol.replace(/:$/, ''),
          'server.address': url?.hostname,
          'server.port': url?.port ? Number(url.port) : undefined,
          'user_agent.original': nonEmpty(request.headers.get('user-agent'), (value) => redactor.text(value)),
          'marmeon.request.id': request.requestId,
          'marmeon.region': request.region,
          ...capturedHeaders(request, requestHeaders, redactor),
        }, parent, links ? { links } : {});
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
            'url.query': url && url.search.length > 1 ? redactor.text(recordQueryValues ? url.search.slice(1) : queryKeys(url.search)) : undefined,
            'marmeon.route.name': request.route,
            'marmeon.controller': request.controller,
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
              ...deployment,
              'db.system.name': system,
              // The statement only — its parameters never (E125): Kysely binds every value, so the text holds placeholders.
              'db.query.text': redactor.text(query.sql),
              'db.operation.name': operation,
              'db.collection.name': table,
              'marmeon.db.connection': query.connection,
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
          'marmeon.queue.connection': dispatch.connection,
          'marmeon.queue.jobs': [...dispatch.jobs],
          'marmeon.queue.delay': dispatch.delay > 0 ? dispatch.delay : undefined,
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
            'marmeon.job': job.job,
            'marmeon.job.attempt': job.attempt,
            'marmeon.queue.connection': job.connection,
            'marmeon.request.origin_id': job.originRequestId,
          },
          dispatched ?? api.context.active(),
        );
      },
      end: ender<QueueJobMessage>((span, job) => {
        if (job.outcome !== undefined) span.setAttribute('marmeon.job.outcome', job.outcome);
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
    (task) => ({ name: `schedule ${task.task}`, attributes: { 'marmeon.schedule.task': task.task, 'marmeon.schedule.reason': task.reason } }),
    (span, task) => {
      span.setAttributes(clean({ 'marmeon.schedule.outcome': task.outcome, 'marmeon.schedule.skipped': task.skipped }));
      if (task.outcome === 'failed' && task.error === undefined) span.setStatus({ code: api.SpanStatusCode.ERROR });
    },
  );
  // Mails: which mailable, how; recipients only counted — addresses and subjects are personal data.
  simple(
    'mail.send',
    api.SpanKind.CLIENT,
    (mail) => ({ name: `mail ${mail.mailable}`, attributes: { 'marmeon.mail.mailable': mail.mailable, 'marmeon.mail.mode': mail.mode } }),
    (span, mail) => {
      if (mail.to !== undefined) span.setAttribute('marmeon.mail.recipients', mail.to.length);
    },
  );
  simple(
    'notification.send',
    api.SpanKind.INTERNAL,
    (notification) => ({
      name: `notify ${notification.notification}`,
      attributes: { 'marmeon.notification': notification.notification, 'marmeon.notification.queued': notification.queued, 'marmeon.notification.recipient_type': notification.recipient.type },
    }),
    (span, notification) => {
      span.setAttributes(clean({ 'marmeon.notification.channels': notification.channels ? [...notification.channels] : undefined, 'marmeon.notification.outcome': notification.outcome }));
    },
  );
  simple('live.refresh', api.SpanKind.PRODUCER, (refresh) => ({
    name: 'live refresh',
    attributes: { 'marmeon.live.channel': refresh.channel, 'marmeon.live.only': refresh.only ? [...refresh.only] : undefined },
  }));
  simple(
    'render.ssr',
    api.SpanKind.INTERNAL,
    (render) => ({ name: `render ${render.component}`, attributes: { 'marmeon.view': render.component, 'marmeon.ssr.complete': render.complete } }),
    (span, render) => {
      if (render.streamed !== undefined) span.setAttribute('marmeon.ssr.streamed', render.streamed);
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

/** A query string's keys without their values, in order and as sent: `?q=ada&page=2&flag` → `q=&page=&flag`. */
function queryKeys(search: string): string {
  return search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => part !== '')
    .map((part) => (part.includes('=') ? `${part.slice(0, part.indexOf('='))}=` : part))
    .join('&');
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
