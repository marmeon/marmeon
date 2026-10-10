# @marmeon/otel

OpenTelemetry traces for Marmeon apps: requests, queries, jobs, scheduled runs, mails, notifications, live hints and server
rendering as spans, through the OpenTelemetry API.

## Installation

```sh
pnpm add @marmeon/otel @opentelemetry/api@^1.9.0
pnpm add @opentelemetry/sdk-trace @opentelemetry/context-async-hooks @opentelemetry/core @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http
```

The API is a peer, never a dependency of this package: your SDK registers its tracer provider on the API, and the framework must
read that same copy. The SDK and the exporter are your app's — install them as dependencies, since they run in production.
Without the API the start fails and names the command.

## Starting the SDK

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

```sh
OTEL_SERVICE_NAME=notes OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 NODE_OPTIONS='--import ./bootstrap/telemetry.ts' marmeon start
```

## Documentation

- [Observability: OpenTelemetry](https://github.com/marmeon/marmeon/blob/main/docs/observability.md#opentelemetry)
- [Observability: what it records](https://github.com/marmeon/marmeon/blob/main/docs/observability.md#what-it-records)
- [Observability: a caller's traceparent](https://github.com/marmeon/marmeon/blob/main/docs/observability.md#a-callers-traceparent)
- [Deployment: traces](https://github.com/marmeon/marmeon/blob/main/docs/deployment.md#traces)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
