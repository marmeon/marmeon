# @bespokecore/otel

OpenTelemetry traces for a BespokeCore app (E120): requests, queries, jobs, scheduled tasks, mails, notifications, live hints and
server rendering as spans, following OpenTelemetry's semantic conventions — from the framework's own observation points
([`@bespokecore/core/diagnostics`](../core/README.md#diagnostics-bespokecorecorediagnostics-e118), E118). It talks only to
`@opentelemetry/api`; **the SDK and the exporter are the app's**. No auto-instrumentation, no module hooks (Node 26 deprecates
`module.register()`, DEP0205): nothing patches a module.

```sh
pnpm add @bespokecore/otel @opentelemetry/api
# the SDK and an exporter — what your backend speaks:
pnpm add @opentelemetry/sdk-trace @opentelemetry/context-async-hooks @opentelemetry/core @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http
```

`bespoke discover` registers its `OtelServiceProvider` like any installed package. `@opentelemetry/api` is an optional peer the
app installs; the package itself depends on nothing of the SDK. Install the SDK as **dependencies**, not dev dependencies: it runs
in production, and a production install (`pnpm install --prod`, `make:docker`'s image) leaves dev dependencies out.

## Starting the SDK

The SDK must be registered **before the app boots** — the provider looks for it while booting; without one it subscribes to
nothing. Start it with Node's `--import`, in every process of the app — `bespoke start`, `queue:work` and `schedule:work` each
run in the one Node process `bespoke` started (E159), which reads `NODE_OPTIONS` itself. With `make:docker`'s files put it into
`.env.production` (every role reads it) or an `Environment=` line of the systemd units:

```sh
OTEL_SERVICE_NAME=shop OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 NODE_OPTIONS='--import ./bootstrap/telemetry.ts' bespoke start
```

```ts
// bootstrap/telemetry.ts — the SDK packages as they are named from SDK 3 on (`@opentelemetry/sdk-trace`, 15.10.2026)
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, detectResources, envDetector } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

const resource = defaultResource().merge(detectResources({ detectors: [envDetector] })); // OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());     // spans nest
propagation.setGlobalPropagator(new W3CTraceContextPropagator());                       // a caller's traceparent continues its trace
trace.setGlobalTracerProvider(new TracerProvider({ resource, spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })] }));
```

Or, shorter but with every exporter (gRPC, protobuf) in `node_modules`:

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
new NodeSDK({ traceExporter: new OTLPTraceExporter() }).start();   // registers the context manager and propagator too
```

- **No `SIGTERM` handler of your own:** `bespoke` stops the server gracefully; the provider flushes the SDK's spans when the app
  shuts down (≤ 2 s), so the last requests' and jobs' spans are exported.
- **Without a context manager** (a bare `TracerProvider` without `AsyncLocalStorageContextManager`) spans are recorded but
  never nested — the provider warns at boot.
- `apps/web-app/bootstrap/telemetry.ts` is the working example.

## What it records

One span per operation; the operation's work runs inside its span (`channels.around`), so what happens there — its queries,
the jobs it dispatches, its log lines, **your own spans** (`trace.getActiveSpan()`, `tracer.startActiveSpan(…)` in a
controller) — is its child.

| Operation | Span | Notes |
|---|---|---|
| Request | `GET /users/:user` — server | `http.route`, `http.response.status_code`, `url.path`, … Status error only for a 5xx (with `error.type` and the exception); a 4xx is the client's. A caller's `traceparent` header continues its trace. Islands and a layer's base resolved in-process: internal children. |
| Query | `SELECT users` — client | `db.query.text` **without parameters** (Kysely binds every value; the text has placeholders), `db.system.name`, `db.operation.name`, `db.collection.name`. Only inside another span: a statement outside every span (a health check, a CLI command) is no trace of its own. |
| Dispatch | `send <job>` — producer | Its context goes with the job as W3C `traceparent` ([E131](../queue/README.md#job-events)) — in the jobs table, the Redis list, the `QueueFake`. |
| Job | `process <job>` — consumer | Child of its dispatch: a job runs in the trace of the request (task, job) that dispatched it — also in another process, also days later. `bespoke.job.outcome`, `bespoke.request.origin_id`. |
| Scheduled task | `schedule <task>` | Each run a trace of its own. |
| Mail | `mail <Mailable>` — client | The mode (`send`, `queue`, `worker`) and the number of recipients — never addresses or the subject. |
| Notification, live hint, SSR | `notify <name>`, `live refresh`, `render <View>` | |

The core README lists every attribute: [what `@bespokecore/otel` makes of them](../core/README.md#what-bespokecoreotel-makes-of-them-e120).

**Log lines** written inside a span carry its `trace_id`, `span_id` and `trace_flags` ([@bespokecore/log](../log/README.md)'s mixin,
through core's `LogContextSources` — [the channels](../core/README.md#the-channels)) — the request's own line `GET /users/7 200`
too. Logs and traces join on `trace_id`.

**Not traced:** `/up` and `/up/ready` ([health](../server/README.md#health-e126), E126) — the health endpoints answer before the
request pipeline.

## Redaction (E125)

Every attribute and exception that may hold a secret passes the app's `Redactor` ([redaction](../core/README.md#redaction-e125)) —
the same one the error page and the [devtools](../devtools/README.md#redaction-e125--also-locally) use: `url.query`
(`token=[redacted]`), `user_agent.original`, exception messages and stacks, the query text, and path segments of route parameters
with a sensitive name (`/reset/:token` → `/reset/[redacted]`). Query parameters are never recorded. Request headers only when you
name them, redacted by name (`authorization`, `cookie`, the session cookie → `[redacted]`):

```sh
OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST=x-tenant,accept-language   # → http.request.header.x-tenant = ['acme']
```

## Configuration

| Variable | Default | |
|---|---|---|
| `OTEL_SDK_DISABLED` | `false` | `true`: the provider subscribes to nothing (the SDK honours it too). |
| `OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST` | — | Request headers recorded as `http.request.header.<name>`, comma-separated. |

`OtelConfig` is the package's config class (`config.disabled`, `config.requestHeaders` — lower-cased names). Everything else is
the SDK's (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER`, …).

- **No SDK, no cost:** without a registered tracer provider (checked through the API: the global provider still delegates to the
  no-op one) the provider subscribes to nothing — no message is built, no span, no error; one debug line says why.
- **`@opentelemetry/api` missing:** the start fails with `@bespokecore/otel needs the OpenTelemetry API, which is not installed in
  this app: pnpm add @opentelemetry/api` (also a solution on the error page, [E130](../core/README.md#solutions-e130)) — unless
  `OTEL_SDK_DISABLED=true`: then the API is not even loaded.

## Testing

Register an SDK with an in-memory exporter before the test app boots (`createTestApp` of
[@bespokecore/testing](../testing/README.md); Vitest runs each test file in a worker of its own):

```ts
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

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

it('traces a registration', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  await app.post('/register', { form: { … } });
  await app.queue.work();                      // the welcome job — in the request's trace
  await provider.forceFlush();
  expect(exporter.getFinishedSpans().map((span) => span.name)).toContain('POST /register');
});
```
