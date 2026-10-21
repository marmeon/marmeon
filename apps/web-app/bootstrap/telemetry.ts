/**
 * OpenTelemetry for this app: the SDK and its exporter are the app's, and @marmeon/otel records spans once one is registered.
 * Loaded before the app boots — `NODE_OPTIONS='--import ./bootstrap/telemetry.ts' marmeon start`; see
 * `docs/observability.md#starting-the-sdk`. The packages are devDependencies of this demo app (it ships without telemetry).
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
  // Spans nest through the async context; a caller's `traceparent` header is a link of the request's span — its parent only with
  // MARMEON_OTEL_TRUST_TRACEPARENT=true (behind an edge that sets the header, docs/observability.md#a-callers-traceparent).
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
}
