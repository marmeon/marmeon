import { createApplication, defineModule, Logger } from '@bespokecore/core';
import { channels } from '@bespokecore/core/diagnostics';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { HttpServiceProvider } from '@bespokecore/http';
import { defineRoutes } from '@bespokecore/router';
import { createHttpKernel, ServerServiceProvider } from '@bespokecore/server';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, describe, expect, it } from 'vitest';
import { OtelServiceProvider } from './index.ts';

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

async function boot() {
  const logger = new Recording();
  const app = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey() },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, OtelServiceProvider],
    modules: [defineModule({ name: 'app', routes: defineRoutes((Route) => void Route.get('/hello', () => ({ hello: true }))) })],
    override: (container) => container.instance(Logger, logger),
  });
  return { app, logger };
}

describe('@bespokecore/otel without an SDK (E120)', () => {
  it('no SDK registered: no subscription, no message built, no span, no error — one debug line', async () => {
    const { app, logger } = await boot();
    try {
      expect(channels.tracing('http.request').hasSubscribers).toBe(false);
      const response = await createHttpKernel(app).request('/hello');
      expect(response.status).toBe(200);
      expect(channels.built(app)).toBe(0);
      expect(logger.lines.filter((line) => line.level !== 'info')).toEqual([
        { level: 'debug', message: 'No OpenTelemetry SDK is registered — no spans. Start one before the app boots (packages/otel/README.md).' },
      ]);
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
