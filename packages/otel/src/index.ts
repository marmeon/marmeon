import { defineConfig, defineSolutions, LogContextSources, Logger, Redactor, type Application, type ConfigOf, type ServiceProvider } from '@marmeon/core';
import * as v from 'valibot';
import { contextPropagates, loadOtelApi, OTEL_INSTALL, OtelSetupError, sdkRegistered, type OtelApi } from './api.ts';
import { instrument } from './tracer.ts';

// OpenTelemetry (E120): spans from the framework's channels (E118), through `@opentelemetry/api` only — the SDK and its
// exporter are the app's (`bootstrap/telemetry.ts`). No auto-instrumentation, no module hooks (Node 26: DEP0205).
export { contextPropagates, loadOtelApi, OTEL_INSTALL, OtelSetupError, sdkRegistered } from './api.ts';
export type { ImportOtelApi } from './api.ts';
export { instrument, redactedPath, traceparentOf } from './tracer.ts';
export type { InstrumentOptions } from './tracer.ts';

const list = v.pipe(
  v.string(),
  v.transform((value) => value.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)),
);

/**
 * The OpenTelemetry environment this package reads — the SDK reads its own (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_*`, …):
 *
 * ```sh
 * OTEL_SDK_DISABLED=true                                        # no spans from Marmeon (the SDK honours it too)
 * OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST=x-tenant,accept-language   # recorded request headers, redacted
 * OTEL_TRUST_TRACEPARENT=true                                   # continue a caller's trace — only behind an edge that sets the header
 * ```
 */
export const OtelConfig = defineConfig('otel', {
  env: v.object({
    OTEL_SDK_DISABLED: v.optional(v.pipe(v.string(), v.toLowerCase(), v.picklist(['true', 'false'])), 'false'),
    OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST: v.optional(list, ''),
    OTEL_TRUST_TRACEPARENT: v.optional(v.pipe(v.string(), v.toLowerCase(), v.picklist(['true', 'false'])), 'false'),
  }),
  resolve: (env) => ({
    disabled: env.OTEL_SDK_DISABLED === 'true',
    requestHeaders: env.OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST,
    /** Continue an incoming request's trace (`traceparent`) instead of linking it — see `InstrumentOptions.trustTraceparent`. */
    trustTraceparent: env.OTEL_TRUST_TRACEPARENT === 'true',
  }),
});
export type OtelConfig = ConfigOf<typeof OtelConfig>;

/**
 * Subscribes to the app's channels and records spans — when an OpenTelemetry SDK is registered by the time the app boots
 * (start it first: `node --import ./bootstrap/telemetry.ts`, see the README). Without one, nothing is subscribed: no span,
 * no cost, no error. `@opentelemetry/api` must be installed (an optional peer): the start fails with what to install.
 * On shutdown it unsubscribes and flushes the SDK's spans (≤ 2 s), so the last requests' and jobs' spans are not lost.
 * Found by `marmeon discover`.
 */
export class OtelServiceProvider implements ServiceProvider {
  static config = [OtelConfig];
  /** The missing API, on the error page and when `marmeon` cannot start the app (E130). */
  static solutions = defineSolutions([
    {
      for: OtelSetupError,
      solve: () => ({
        title: 'Install the OpenTelemetry API',
        text: '@marmeon/otel records spans through @opentelemetry/api, an optional peer the app installs — the SDK and its exporter are the app\'s too.',
        command: OTEL_INSTALL,
        docs: 'packages/otel/README.md#starting-the-sdk',
      }),
    },
  ]);

  #off: (() => void) | undefined;
  #api: OtelApi | undefined;

  async boot(app: Application): Promise<void> {
    const config = app.container.make(OtelConfig);
    if (config.disabled) return;
    const api = await loadOtelApi();
    const logger = app.container.make(Logger).child({ channel: 'otel' });
    if (!sdkRegistered(api)) {
      logger.debug('No OpenTelemetry SDK is registered — no spans. Start one before the app boots (packages/otel/README.md).');
      return;
    }
    if (!contextPropagates(api)) {
      logger.warn('OpenTelemetry has no context manager: spans are recorded, but never nested (a query is not the child of its request). NodeSDK registers one; with a bare TracerProvider, register AsyncLocalStorageContextManager.');
    }
    this.#api = api;
    this.#off = instrument(app, api, {
      redactor: app.container.has(Redactor) ? app.container.make(Redactor) : new Redactor(),
      ...(app.container.has(LogContextSources) ? { logContext: app.container.make(LogContextSources) } : {}),
      requestHeaders: config.requestHeaders,
      trustTraceparent: config.trustTraceparent,
    });
  }

  async shutdown(): Promise<void> {
    this.#off?.();
    this.#off = undefined;
    const api = this.#api;
    this.#api = undefined;
    if (!api) return;
    // The SDK's provider (behind the API's proxy) exports what it still holds: the spans of the last requests and jobs.
    const provider = api.trace.getTracerProvider() as { getDelegate?: () => unknown };
    const delegate = (typeof provider.getDelegate === 'function' ? provider.getDelegate() : provider) as { forceFlush?: () => Promise<void> };
    if (typeof delegate.forceFlush !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([delegate.forceFlush().catch(() => undefined), new Promise((resolve) => (timer = setTimeout(resolve, 2_000)))]);
    clearTimeout(timer);
  }
}
