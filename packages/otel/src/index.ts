import { defineConfig, defineSolutions, env, EnvironmentConfig, LogContextSources, Logger, Redactor, type Application, type ConfigOf, type ServiceProvider } from '@marmeon/core';
import { contextPropagates, loadOtelApi, OTEL_INSTALL, OtelSetupError, sdkRegistered, type OtelApi } from './api.ts';
import { instrument } from './tracer.ts';

export { OtelSetupError } from './api.ts';

// OpenTelemetry: spans from the framework's channels, through `@opentelemetry/api` only — the SDK and its
// exporter are the app's (`bootstrap/telemetry.ts`). No auto-instrumentation, no module hooks (Node 26: DEP0205).

/**
 * The OpenTelemetry environment this package reads — the SDK reads its own (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_*`, …):
 *
 * ```sh
 * OTEL_SDK_DISABLED=true                                        # no spans from Marmeon (the SDK honours it too)
 * OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST=x-tenant,accept-language   # recorded request headers, redacted
 * MARMEON_OTEL_TRUST_TRACEPARENT=true                           # continue a caller's trace — only behind an edge that sets the header
 * MARMEON_OTEL_RECORD_QUERY_VALUES=true                         # url.query with its values (masked), not only its keys
 * ```
 */
export const OtelConfig = defineConfig('otel', {
  env: env({
    /**
     * The specification's switch: only `true`, in any case, disables the SDK and any other value leaves it on. Marmeon reads it
     * the same way, or it and the SDK would disagree about whether spans are recorded.
     */
    OTEL_SDK_DISABLED: env.string().default('false'),
    OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST: env.list(env.string()).default([]),
    MARMEON_OTEL_TRUST_TRACEPARENT: env.boolean().default(false),
    MARMEON_OTEL_RECORD_QUERY_VALUES: env.boolean().default(false),
  })
    .renamed('OTEL_TRUST_TRACEPARENT', 'MARMEON_OTEL_TRUST_TRACEPARENT')
    .renamed('OTEL_RECORD_QUERY_VALUES', 'MARMEON_OTEL_RECORD_QUERY_VALUES'),
  resolve: (e) => ({
    disabled: e.OTEL_SDK_DISABLED.toLowerCase() === 'true',
    /** @internal `OTEL_SDK_DISABLED` is neither `true` nor `false`: boot warns about it. */
    sdkDisabledUnrecognised: !['true', 'false'].includes(e.OTEL_SDK_DISABLED.toLowerCase()),
    requestHeaders: e.OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST.map((name) => name.toLowerCase()),
    /** Continue an incoming request's trace (`traceparent`) instead of linking it (MARMEON_OTEL_TRUST_TRACEPARENT, docs/observability.md#a-callers-traceparent). */
    trustTraceparent: e.MARMEON_OTEL_TRUST_TRACEPARENT,
    /** `url.query` with its values (masked as text) — by default only its keys leave the process. */
    recordQueryValues: e.MARMEON_OTEL_RECORD_QUERY_VALUES,
  }),
});
export type OtelConfig = ConfigOf<typeof OtelConfig>;

/**
 * Subscribes to the app's channels and records spans — when an OpenTelemetry SDK is registered by the time the app boots
 * (start it first: `node --import ./bootstrap/telemetry.ts`, docs/observability.md#starting-the-sdk). Without one, nothing is
 * subscribed: no span, no cost, no error. `@opentelemetry/api` must be installed (an optional peer): the start fails with
 * what to install. On shutdown it unsubscribes and flushes the SDK's spans (≤ 2 s), so the last requests' and jobs' spans
 * are not lost. Found by `marmeon discover`.
 */
export class OtelServiceProvider implements ServiceProvider {
  static config = [OtelConfig];
  /** The missing API, on the error page and when `marmeon` cannot start the app. */
  static solutions = defineSolutions([
    {
      for: OtelSetupError,
      solve: () => ({
        title: 'Install the OpenTelemetry API',
        text: '@marmeon/otel records spans through @opentelemetry/api, an optional peer the app installs — the SDK and its exporter are the app\'s too.',
        command: OTEL_INSTALL,
        docs: 'docs/observability.md#installation',
      }),
    },
  ]);

  #off: (() => void) | undefined;
  #api: OtelApi | undefined;

  async boot(app: Application): Promise<void> {
    const config = app.container.make(OtelConfig);
    const logger = app.container.make(Logger).child({ channel: 'otel' });
    // The specification asks for a warning, and for the value to count as `false`.
    if (config.sdkDisabledUnrecognised) {
      logger.warn('OTEL_SDK_DISABLED is neither "true" nor "false": spans stay on. Only "true" disables them.');
    }
    if (config.disabled) return;
    const api = await loadOtelApi();
    if (!sdkRegistered(api)) {
      logger.debug('No OpenTelemetry SDK is registered — no spans. Start one before the app boots (docs/observability.md#starting-the-sdk).');
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
      recordQueryValues: config.recordQueryValues,
      ...(app.container.has(EnvironmentConfig) ? { environment: app.container.make(EnvironmentConfig).app } : {}),
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
