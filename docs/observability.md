# Observability

## Introduction

The channel names and the shape of their messages are stable. `@marmeon/otel` is experimental: it can change in any minor release. See [the release policy](releases.md#experimental).

The framework reports what it does: every request, query, job, mail, notification, live hint, scheduled run, command, log entry,
exception and event. It publishes these reports on channels of Node's `node:diagnostics_channel`, and the framework's tools
listen in, among others the [devtools](devtools.md) and the `Server-Timing` header while you develop, and OpenTelemetry in
production. Your own code can listen too:

```ts title="modules/system/SlowQueryServiceProvider.ts"
import { Logger, type Application, type ServiceProvider } from '@marmeon/core';
import { channels } from '@marmeon/core/diagnostics';

export class SlowQueryServiceProvider implements ServiceProvider {
  #off: (() => void) | undefined;

  boot(app: Application): void {
    const log = app.container.make(Logger).child({ channel: 'db' });
    this.#off = channels.subscribe(app, 'db.query', {
      end: (query) => {
        if (query.durationMs >= 500) log.warn('Slow query', { sql: query.sql, ms: Math.round(query.durationMs) });
      },
    });
  }

  shutdown(): void {
    this.#off?.();
  }
}
```

List the provider in the module's `providers`, as the [service providers](providers.md) page shows. When nothing listens to a
channel, the framework builds no report for it at all, so the channels cost nothing in an app that does not use them.

## The channels

| Channel | Reported | What a report holds besides the common fields |
| --- | --- | --- |
| `http.request` | Every request, also an island or a layer's base the server resolves for a page. | Method, path, URL, headers, route name and pattern, controller, status, a redirect's target, the page and the size of each prop, the input. |
| `db.query` | Every statement, on every connection, once it ran. | Connection, driver, SQL, parameters, and `secret`. |
| `queue.dispatch` | `dispatch()`, `bulk()` and `chain()`. | The jobs, their ids, connection, queue, delay, unique key, payloads. |
| `queue.job` | Each attempt of a job, in a worker or in a test. | The job, its id, queue, attempt, the id of the request that dispatched it, payload, outcome. |
| `schedule.task` | Each run of a scheduled task. | Task, minute, reason, outcome. |
| `mail.send` | Each mail sent, queued, or sent later by a worker. | The mailable, the mode, the addresses, subject, text, HTML, attachments. |
| `notification.send` | Each send and each delivery. | Notification, id, recipient, channels, outcome. |
| `live.refresh` | Each live hint, after its commit. | Channel and the props it names. |
| `render.ssr` | Each server rendering of a document. | Component, and whether it rendered completely or streamed. |
| `command.run` | Each `marmeon` command in a process of its own. | Command, arguments, exit code. |
| `log` | Every log entry, at any level. | Level, message, context. |
| `exception` | The error a request ends in. | The error, status, method, path and the request's `Sec-Fetch-Site`, if it sent one. |
| `event` | Every event dispatched. | The event, its name, its listeners. |

Every report names its app and carries the time it started and where it happened: the `requestId`, the `jobId` or the scheduled
`task`. A report of an operation that ended also has `durationMs`, and `error` when it failed. The types name each report:
`ChannelMessage<'db.query'>` is the report of a query, and a misspelt channel or field is a compile error.

### Subscribing

`channels.subscribe(app, name, handlers)` listens to one channel and returns a function that stops listening. A provider
subscribes in `boot()` and stops in `shutdown()`. The handlers depend on the kind of channel:

- An **operation** such as `http.request` or `db.query` takes `{ start, end, error }`. `start` runs before the operation, `end`
  after it, whether it succeeded or failed, and `error` when it failed. A query is reported once it ran, so its `start` comes
  after the statement too.
- A **plain channel**, `log`, `exception` or `event`, takes one function.

A subscription hears only the reports of its own app, so two apps in one process, such as parallel tests, never mix. A handler
that throws is reported as a process warning, and the operation goes on. A subscriber of `log` must not write to the log itself.

> [!WARNING]
> Reports carry raw values: a query's parameters, the context of a log entry, a request's headers and input, the error itself.
> Before you record or send any of it, pass it through the app's `Redactor`: `app.container.make(Redactor).query(query)` gives a
> query's SQL with its parameters masked, and none at all when `secret` is true. The
> [logging](logging.md#keeping-secrets-out-of-the-log) page explains the redaction.

### Queries and secret columns

`secret` is `true` when a statement touches a table with [secret columns](migrations.md#secret-columns). Its parameters may hold a
password hash or a token, so whatever records queries shows none of them. The devtools record such a statement without parameters,
and OpenTelemetry never records parameters at all.

`Connections` of `@marmeon/database` has a plain listener for code that counts queries itself, such as a test:
`connections.onQuery(listener)` hears every statement of every connection with its `connection`, `sql`, `parameters`,
`durationMs` and `error`, and returns the function that stops it. It knows no `secret` flag and passes the parameters as they
are, so keep it out of anything that records or ships them. The catalog queries a connection runs to learn its schema, its
relations and secret columns, are not statements of the app: no listener, log or devtools panel sees them.

### The log channel

Every log entry goes to the `log` channel while something listens, at any level, before the logger's own level decides whether to
write it. The devtools record the log this way, and the development error page shows the log entries of the failed request. In a
test, the channel is the way to assert on log entries without parsing lines:

```ts title="modules/notes/log.test.ts"
import { channels, type LogMessage } from '@marmeon/core/diagnostics';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('logs a request line', async () => {
  const app = await createTestApp(application);
  const entries: LogMessage[] = [];
  const off = channels.subscribe(app.application, 'log', (entry) => void entries.push(entry));
  await app.get('/nothing-here').assertNotFound();
  off();
  expect(entries).toContainEqual(expect.objectContaining({ level: 'info', message: 'GET /nothing-here 404' }));
});
```

### Events

The `event` channel reports every dispatch, before a test's event fake decides whether listeners run. It suits code that watches
all events, such as an audit trail. For your own reactions to one event, write a [listener](events.md).

## Following a request

Every response carries the request's id in `x-request-id`: the client's own when it sent a sane one, otherwise a new one. Every
log entry written during the request carries it as `requestId`. A job dispatched in the request remembers it, so the job's log
entries and reports point back to the request that caused them, also in a worker on another machine. The devtools show a
request with everything it set off, and OpenTelemetry puts the job into the request's trace.

## Server-Timing in development

With `NODE_ENV=development`, every response says what its request spent, and the browser's network panel shows it:

```text
Server-Timing: app;dur=18.4;desc="App", db;dur=3.1;desc="4 queries", ssr;dur=9.7;desc="SSR"
```

`app` is the request until its response, or until the page's frame for a streamed page. `db` is the time of its queries and how
many there were. `ssr` is the server rendering until the frame, when the page rendered on the server. The header exists only
with `NODE_ENV=development`: not with `test`, not on staging, never in production.

## OpenTelemetry

`@marmeon/otel` turns the channels into OpenTelemetry spans: requests, queries, jobs, scheduled runs, mails, notifications, live
hints and server rendering, following OpenTelemetry's semantic conventions. It talks only to the OpenTelemetry API. The SDK and
the exporter are your app's, so you choose what your tracing backend speaks. Nothing patches a module, and there is no
auto-instrumentation.

### Installation

```sh
pnpm add @marmeon/otel @opentelemetry/api@^1.9.0
pnpm add @opentelemetry/sdk-trace @opentelemetry/context-async-hooks @opentelemetry/core @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http
```

The API is a peer of `@marmeon/otel`, never a dependency of its own: your SDK registers its tracer provider on the API, and the
framework must read that same copy. Install the SDK as dependencies, not dev dependencies: it runs in production, and a production
install leaves dev dependencies out. Without the API the start fails, and its message starts with what to install:

```text
[marmeon:S4] @marmeon/otel needs the OpenTelemetry API, which is not installed in this app: pnpm add @opentelemetry/api@^1.9.0
```

### Starting the SDK

The SDK must be registered before the app boots. Write it as a file of its own:

```ts title="bootstrap/telemetry.ts"
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, detectResources, envDetector } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

const resource = defaultResource().merge(detectResources({ detectors: [envDetector] }));
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(new TracerProvider({ resource, spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })] }));
```

Node loads it first with `--import`, in every process of the app:

```sh
OTEL_SERVICE_NAME=notes OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 NODE_OPTIONS='--import ./bootstrap/telemetry.ts' marmeon start
```

`marmeon start`, `queue:work` and `schedule:work` each run in one Node process, which reads `NODE_OPTIONS`. With the files of
`make:docker`, put the three variables into `.env.production`, which every container reads. The
[deployment](deployment.md#no-env-in-the-image) page covers that file.

- **The context manager** makes spans nest, so a query is the child of its request. Without it spans are recorded flat, and the
  start warns.
- **The propagator** reads a caller's `traceparent` header, which becomes a link, as [below](#a-callers-traceparent).
- **No `SIGTERM` handler.** `marmeon` stops the server gracefully, and the provider flushes the SDK's spans when the app shuts
  down, for at most two seconds. The spans of the last requests and jobs are exported.
- **Without an SDK** the provider subscribes to nothing: no span, no cost, no error.

`@opentelemetry/sdk-node` starts in one line with `new NodeSDK({ traceExporter }).start()`, which registers the context manager
and the propagator too, but it installs every exporter there is.

### What it records

Each operation is one span, and its work runs inside the span. What happens there, such as its queries, the jobs it dispatches,
its log entries and your own spans, becomes its child:

| Operation | Span | Notes |
| --- | --- | --- |
| Request | `GET /notes/:note`, server | `http.route`, `http.response.status_code`, `url.path`, the route's name and controller. A `5xx` marks the span as failed, with the exception. A `4xx` is the client's and does not. |
| Query | `SELECT notes`, client | `db.query.text` without parameters, `db.system.name`, `db.operation.name`, `db.collection.name`. Only inside another span. |
| Dispatch | `send <job>`, producer | Its context travels with the job as `traceparent`. |
| Job | `process <job>`, consumer | A child of its dispatch, so a job runs in the trace of the request that dispatched it, also in another process, also days later. |
| Scheduled task | `schedule <task>` | Each run starts a trace of its own. |
| Mail | `mail <Mailable>`, client | The mode and the number of recipients, never an address or the subject. |
| Notification | `notify <notification>` | The channels and the outcome. |
| Live hint | `live refresh`, producer | The channel and the props it names. |
| Server rendering | `render <View>` | Whether it rendered completely or streamed. |

The attributes follow OpenTelemetry's semantic conventions, and the names under `marmeon.` are the framework's own. Build
dashboards and alerts on these names:

| Span | Attributes |
| --- | --- |
| Request | `http.request.method` (`_OTHER` for a method outside the standard ones, with `http.request.method_original`), `http.route`, `http.response.status_code`, `url.scheme`, `url.path` with sensitive route parameters redacted, `url.query` (its keys only, unless `MARMEON_OTEL_RECORD_QUERY_VALUES=true`) and `user_agent.original` redacted, `server.address`, `server.port`, `http.request.header.<name>` for the headers you name, `marmeon.request.id`, `marmeon.region` (`island` or `layer`), `marmeon.route.name`, `marmeon.controller`. A request without a route is named after its method alone. |
| Query | `db.system.name`, `db.query.text` (the statement, never its parameters), `db.operation.name`, `db.collection.name`, `marmeon.db.connection`. |
| Dispatch | `messaging.system` (`marmeon`), `messaging.operation.type` (`send`), `messaging.operation.name` (`dispatch`, `bulk` or `chain`), `messaging.destination.name` (the queue), `messaging.message.id` for one job, `messaging.batch.message_count` for several, `marmeon.queue.connection`, `marmeon.queue.jobs`, `marmeon.queue.delay` in seconds. Several jobs make one span named `send <queue>`. |
| Job | `messaging.system`, `messaging.operation.type` (`process`), `messaging.destination.name`, `messaging.message.id`, `marmeon.job`, `marmeon.job.attempt` (from 1), `marmeon.queue.connection`, `marmeon.request.origin_id` (the request that dispatched it), `marmeon.job.outcome` (`done`, `discarded`, `released` or `failed`). |
| Scheduled task | `marmeon.schedule.task`, `marmeon.schedule.reason` (`due`, `catch-up` or `test`), `marmeon.schedule.outcome` (`ran`, `skipped` or `failed`), `marmeon.schedule.skipped` (`filter`, `other-server`, `overlapping` or `job-waiting`). |
| Mail | `marmeon.mail.mailable`, `marmeon.mail.mode` (`send`, `queue` or `worker`), `marmeon.mail.recipients` (a count). |
| Notification | `marmeon.notification`, `marmeon.notification.queued`, `marmeon.notification.recipient_type`, `marmeon.notification.channels`, `marmeon.notification.outcome` (`delivered`, `gone` or `delivered-before`). |
| Live hint | `marmeon.live.channel`, `marmeon.live.only`. |
| Server rendering | `marmeon.view`, `marmeon.ssr.complete`, `marmeon.ssr.streamed`. |

Every span the framework records also carries `deployment.environment.name`: the app's `APP_ENV`, such as `staging`, or the name
that goes with `NODE_ENV`, as the [configuration](configuration.md#app_env-the-environments-name) page explains. The resource belongs to
your SDK. To name the environment there too, set `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=staging` beside
`OTEL_SERVICE_NAME`: the `envDetector` above reads it.

A failed operation marks its span as failed, with `error.type` set to the error's class and an `exception` event whose message
and stack are redacted. A request that ends in a `5xx` without an exception gets the status code as its `error.type`. A job or a
scheduled task that failed without throwing, such as a job that called `job.fail()`, gets the error status and `_OTHER` as its
`error.type`, without an `exception` event.

An island or a layer's base that the server resolves for a page is an internal child of the page's request. A statement outside
every span, such as one of a command or a health check, is no trace of its own. `/up` and `/up/ready` are never traced, since they
answer before the request pipeline. Your own spans work as usual:

```ts title="modules/notes/NoteExport.ts"
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('notes');

export async function exportNotes(userId: number, write: () => Promise<void>): Promise<void> {
  await tracer.startActiveSpan('notes export', { attributes: { 'notes.user_id': userId } }, async (span) => {
    try {
      await write();
    } finally {
      span.end();
    }
  });
}
```

Called in a controller, the span is a child of the request's span.

**Log entries** written inside a span carry its `trace_id`, `span_id` and `trace_flags`, the request's own log line included.
Logs and traces join on `trace_id`.

### A caller's `traceparent`

Anyone can send a `traceparent` header. Taken as the parent, it would put the request into a trace the caller picked, and its
sampled flag would decide whether the request is recorded at all. So every request from outside starts a trace of its own, which
your sampler decides on, and a valid incoming `traceparent` becomes a **link** of the request's span. The caller's context stays
findable, and nothing of it is taken, its baggage neither.

`MARMEON_OTEL_TRUST_TRACEPARENT=true` continues the caller's trace instead: the incoming `traceparent` becomes the parent. The caller's
baggage is taken too when your SDK registers a baggage propagator, such as `W3CBaggagePropagator` in a `CompositePropagator`. The
`telemetry.ts` above registers none.

> [!WARNING]
> Turn it on only where the header is yours: behind an edge that sets or strips `traceparent` itself, such as a gateway, an
> ingress or a service mesh, or for an internal service whose only callers are your own services. A trusted proxy in
> `SERVER_TRUSTED_PROXIES` is no such edge by itself, since it usually passes the client's header on unchanged.

A job continues the trace of its dispatch in any case, since its `traceparent` comes from your own queue.

### Redaction

Every attribute and exception that may hold a secret passes the app's redactor, the same one the devtools use: `url.query`,
`user_agent.original`, exception messages and stacks, the query text, and path segments of route parameters with a sensitive
name, so `/reset-password/:token` becomes `/reset-password/[redacted]`. The redactor masks by name and by the shape of a text.

- **The URL's query string** is exported as `url.query` with its keys only: `?q=ada%40example.com&page=2` becomes `q=&page=`, so
  an e-mail address, a search term or a token under a harmless name stays in the process. A part without `=`, such as
  `?ada%40example.com`, could be a value, so it is written as `[redacted]`. `MARMEON_OTEL_RECORD_QUERY_VALUES=true` exports
  the values too, with secret-looking ones masked, while every other value leaves the process as it is.
- **The bound parameters of SQL statements** are never recorded. `db.query.text` is the statement as it is sent: a value written
  into the SQL itself, with `sql.raw()` or `sql.lit()`, is part of the text and is exported.
- **Request headers** are recorded only when you name them, and then redacted by name:

```sh
OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST=x-tenant,accept-language
```

This records `http.request.header.x-tenant`, while `authorization`, `cookie` and the session cookie would show `[redacted]`.

### Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `OTEL_SDK_DISABLED` | `false` | `true`, as the OpenTelemetry specification says (`1` does not count): no spans from the framework, and the API is not even loaded. The SDK honours it too. |
| `OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST` | empty | Request headers to record, separated by commas. |
| `MARMEON_OTEL_TRUST_TRACEPARENT` | `false` | `true` or `1`: an incoming `traceparent` is the parent of the request's span instead of a link. |
| `MARMEON_OTEL_RECORD_QUERY_VALUES` | `false` | `true` or `1`: `url.query` carries the values of the query, masked like any text, not only its keys. |

Everything else belongs to the SDK: `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER` and the rest.

### Testing

Register an SDK with an exporter in memory before the test app boots. Vitest runs each test file in a worker of its own, so the
registration stays in the file:

```ts title="modules/notes/tracing.test.ts"
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { createTestApp } from '@marmeon/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});
afterAll(() => {
  trace.disable();
  context.disable();
});

it('traces a registration with its job', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  await app.post('/register', {
    form: { name: 'Katherine Johnson', email: 'kj@example.com', password: 'orbital mechanics', password_confirmation: 'orbital mechanics' },
  });
  await app.queue.work();
  await provider.forceFlush();
  const names = exporter.getFinishedSpans().map((span) => span.name);
  expect(names).toContain('POST /register');
  expect(names).toContain('process marmeon.listener');
});
```

The test needs the SDK's packages. An app that traces in production has them as dependencies already.
