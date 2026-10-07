/**
 * OpenTelemetry for this app (E120) — the SDK and its exporter are the app's; @marmeon/otel only talks to
 * `@opentelemetry/api` and records spans from the framework's channels once an SDK is registered. Started BEFORE the app
 * boots, through Node's `--import` (no module hooks, no auto-instrumentation — Node 26 deprecates `module.register()`, DEP0205):
 *
 * ```sh
 * OTEL_SERVICE_NAME=web-app OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 NODE_OPTIONS='--import ./bootstrap/telemetry.ts' marmeon start
 * ```
 *
 * Workers and the scheduler inherit `NODE_OPTIONS`: a job's span joins the trace of the request that dispatched it.
 * The packages are devDependencies of this demo app (it ships without telemetry) — a real app lists them as dependencies.
 *
 * Written for the SDK's packages as they are named from SDK 3 on (15.10.2026): `@opentelemetry/sdk-trace` (`TracerProvider`,
 * `BatchSpanProcessor`). With `@opentelemetry/sdk-node` it is shorter, but brings every exporter (gRPC, protobuf):
 *
 * ```ts
 * import { NodeSDK } from '@opentelemetry/sdk-node';
 * import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
 * new NodeSDK({ traceExporter: new OTLPTraceExporter() }).start();
 * ```
 *
 * No `SIGTERM` handler here: `marmeon` stops the server gracefully itself, and @marmeon/otel flushes the spans when the
 * app shuts down.
 */
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

if (process.env.OTEL_SDK_DISABLED?.toLowerCase() !== 'true') {
  const resource = defaultResource()
    .merge(resourceFromAttributes({ 'service.name': 'marmeon-web-app' }))
    // OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES
    .merge(detectResources({ detectors: [envDetector] }));
  // OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318), OTEL_EXPORTER_OTLP_HEADERS, …
  const provider = new TracerProvider({ resource, spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })] });
  // Spans nest through the async context; a caller's `traceparent` header continues its trace.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
}
