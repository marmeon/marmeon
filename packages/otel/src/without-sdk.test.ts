import { createApplication, defineModule, Logger } from '@marmeon/core';
import { channels } from '@marmeon/core/diagnostics';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, describe, expect, it } from 'vitest';
import { OtelServiceProvider } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

// This file registers no SDK first (its own worker: Vitest isolates test files), then one without a context manager.
afterAll(() => trace.disable());

class Recording implements Logger {
  readonly lines: { level: string; message: string }[] = [];
  debug(message: string) {
    this.lines.push({ level: 'debug', message });
  }
  info(message: string) {
    this.lines.push({ level: 'info', message });
  }
  warn(message: string) {
    this.lines.push({ level: 'warn', message });
  }
  error(message: string) {
    this.lines.push({ level: 'error', message });
  }
  child(): Logger {
    return this;
  }
}

async function boot(env: Record<string, string> = {}) {
  const logger = new Recording();
  const app = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, OtelServiceProvider],
    modules: [defineModule({ name: 'app', routes: openRoutes((Route) => void Route.get('/hello', () => ({ hello: true }))) })],
  }, { env: { APP_KEY: generateKey(), ...env }, override: (container) => container.instance(Logger, logger) });
  return { app, logger };
}

describe('@marmeon/otel without an SDK', () => {
  it('no SDK registered: no subscription, no message built, no span, no error — one debug line', async () => {
    const { app, logger } = await boot();
    try {
      expect(channels.tracing('http.request').hasSubscribers).toBe(false);
      const response = await createHttpKernel(app).request('/hello');
      expect(response.status).toBe(200);
      expect(channels.built(app)).toBe(0);
      expect(logger.lines.filter((line) => line.level !== 'info')).toEqual([
        { level: 'debug', message: 'No OpenTelemetry SDK is registered — no spans. Start one before the app boots (docs/observability.md#starting-the-sdk).' },
      ]);
    } finally {
      await app.shutdown();
    }
  });

  it.each(['1', 'yes'])('warns when OTEL_SDK_DISABLED is "%s", neither true nor false, and leaves spans on', async (value) => {
    const { app, logger } = await boot({ OTEL_SDK_DISABLED: value });
    try {
      expect(logger.lines.filter((line) => line.level === 'warn')).toEqual([
        { level: 'warn', message: 'OTEL_SDK_DISABLED is neither "true" nor "false": spans stay on. Only "true" disables them.' },
      ]);
    } finally {
      await app.shutdown();
    }
  });

  it.each(['true', 'FALSE', ''])('does not warn when OTEL_SDK_DISABLED is "%s"', async (value) => {
    const { app, logger } = await boot({ OTEL_SDK_DISABLED: value });
    try {
      expect(logger.lines.filter((line) => line.level === 'warn')).toEqual([]);
    } finally {
      await app.shutdown();
    }
  });

  it('an SDK without a context manager: spans, but a warning that they cannot nest', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    trace.setGlobalTracerProvider(provider);
    const { app, logger } = await boot();
    try {
      await createHttpKernel(app).request('/hello');
      await provider.forceFlush();
      expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['GET /hello']);
      expect(logger.lines.find((line) => line.level === 'warn')?.message).toMatch(/^OpenTelemetry has no context manager: spans are recorded, but never nested/);
    } finally {
      await app.shutdown();
    }
  });
});
