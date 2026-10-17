import type * as Api from '@opentelemetry/api';
import { withCode } from '@marmeon/core/internal';

/** The OpenTelemetry API module (`@opentelemetry/api`) — the one OpenTelemetry package this one talks to. */
export type OtelApi = typeof Api;

/**
 * What to install when the API is missing — a peer, never a dependency: the app's SDK and the framework must share one
 * instance of the API.
 */
export const OTEL_INSTALL = 'pnpm add @opentelemetry/api@^1.9.0';

/**
 * `@opentelemetry/api` is not installed — an optional peer of @marmeon/otel. The message says what to install; the CLI
 * prints it without a stack trace.
 */
export class OtelSetupError extends Error {
  override name = 'OtelSetupError';
}

/** How the API module is loaded — replaced in tests to play a missing one. */
export type ImportOtelApi = () => Promise<unknown>;

const importApi: ImportOtelApi = () => import('@opentelemetry/api' as string);

/** Imports `@opentelemetry/api`, or explains how to install it. Other failures (a broken install) pass through. */
export async function loadOtelApi(load: ImportOtelApi = importApi): Promise<OtelApi> {
  try {
    const module = (await load()) as Partial<OtelApi> & { default?: Partial<OtelApi> };
    const api = (typeof module.trace === 'object' ? module : module.default) as OtelApi | undefined;
    if (!api || typeof api.trace?.getTracer !== 'function' || typeof api.context?.with !== 'function') {
      throw new OtelSetupError(withCode('S4', `The installed "@opentelemetry/api" is not the OpenTelemetry API 1.x: ${OTEL_INSTALL}`));
    }
    return api;
  } catch (error) {
    if (error instanceof OtelSetupError) throw error;
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && typeof message === 'string' && message.includes('@opentelemetry/api')) {
      throw new OtelSetupError(withCode('S4', `@marmeon/otel needs the OpenTelemetry API, which is not installed in this app: ${OTEL_INSTALL} (the SDK and an exporter are the app's, see docs/observability.md#installation).`));
    }
    throw error;
  }
}

/**
 * Whether an SDK registered a tracer provider (`NodeSDK.start()`, `trace.setGlobalTracerProvider(…)`). Without one the API
 * hands out no-op tracers: nothing would be recorded, so nothing is subscribed. Public API only: a fresh `ProxyTracerProvider`
 * delegates to the API's no-op provider — the global one does the same until an SDK registers.
 */
export function sdkRegistered(api: OtelApi): boolean {
  const provider = api.trace.getTracerProvider();
  // Another copy of the API (a second 1.x in node_modules) registered its provider: it is a real one.
  if (!(provider instanceof api.ProxyTracerProvider)) return true;
  return provider.getDelegate() !== new api.ProxyTracerProvider().getDelegate();
}

/** Whether a context manager propagates contexts (`AsyncLocalStorageContextManager`, which `NodeSDK` registers). */
export function contextPropagates(api: OtelApi): boolean {
  const key = api.createContextKey('@marmeon/otel probe');
  return api.context.with(api.ROOT_CONTEXT.setValue(key, true), () => api.context.active().getValue(key) === true);
}
