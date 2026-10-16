import { fileURLToPath } from 'node:url';
import { Clock, createApplication, defineModule, Logger, type HealthCheck } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { channels } from '@marmeon/core/diagnostics';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, ServerClosing } from '@marmeon/http';
import { openRoutes } from './test-helpers/open-routes.ts';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';

/** What the test's checks do — set per test. */
const state = { database: 'ok' as 'ok' | 'down' | 'hang', runs: 0 };

class FakeDatabaseCheck implements HealthCheck {
  static check = 'database';
  static timeout = 100;
  async handle(): Promise<string> {
    state.runs++;
    if (state.database === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1:5432, password=hunter2');
    if (state.database === 'hang') await new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'default';
  }
}
class StorageCheck implements HealthCheck {
  static check = 'storage';
  handle(): void {}
}

/** Records every log line — the health endpoints write none. */
class Recording implements Logger {
  readonly lines: string[] = [];
  debug(message: string) {
    this.lines.push(message);
  }
  info(message: string) {
    this.lines.push(message);
  }
  warn(message: string) {
    this.lines.push(message);
  }
  error(message: string) {
    this.lines.push(message);
  }
  child(): Logger {
    return this;
  }
}

async function boot({ env = {}, routes }: { env?: Record<string, string>; routes?: ReturnType<typeof openRoutes> } = {}) {
  const logger = new Recording();
  // `/up/ready` keeps a result for a second: the tests move this clock past it.
  const clock = new TestClock();
  clock.freeze();
  const application = await createApplication({
    root: fileURLToPath(new URL('../../../', import.meta.url)),
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    health: [FakeDatabaseCheck],
    modules: [defineModule({ name: 'app', health: [StorageCheck], routes: routes ?? openRoutes((Route) => void Route.get('/hello', () => ({ hello: true }))) })],
  }, {
    env: { APP_KEY: generateKey(), ...env },
    override: (container) => {
      container.instance(Logger, logger);
      container.instance(Clock, clock);
    },
  });
  /** Past the second `/up/ready` keeps its last result. */
  const later = () => clock.travel({ seconds: 1 });
  return { application, logger, later };
}

describe('health endpoints', () => {
  it('/up: 200 "OK" before anything else runs — no request id, no log line, no request message, not cached', async () => {
    state.database = 'ok';
    const { application, logger } = await boot();
    const kernel = createHttpKernel(application);
    const requests: unknown[] = [];
    const off = channels.subscribe(application, 'http.request', { start: (message) => void requests.push(message) });
    try {
      const response = await kernel.request('/up');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('OK');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.has('x-request-id')).toBe(false);
      expect(response.headers.has('set-cookie')).toBe(false);
      expect((await kernel.request('/up', { method: 'HEAD' })).status).toBe(200);
      expect(requests).toEqual([]);
      expect(logger.lines).toEqual([]);
      // An app request beside it is logged and traced as always.
      expect((await kernel.request('/hello')).status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(logger.lines).toEqual([expect.stringMatching(/^GET \/hello 200$/)]);
    } finally {
      off();
      await application.shutdown();
    }
  });

  it('/up/ready: every check — 200 {"status":"ok"}; a failing one → 503 {"status":"failing"}, while /up stays 200', async () => {
    const { application, later } = await boot();
    const kernel = createHttpKernel(application);
    try {
      state.database = 'ok';
      let response = await kernel.request('/up/ready');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      expect(response.headers.get('cache-control')).toBe('no-store');

      state.database = 'down';
      later();
      response = await kernel.request('/up/ready');
      expect(response.status).toBe(503);
      // Outside development: no names, no times, no errors.
      expect(await response.json()).toEqual({ status: 'failing' });
      expect((await kernel.request('/up')).status).toBe(200);

      state.database = 'hang';
      later();
      response = await kernel.request('/up/ready');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'failing' });
    } finally {
      await application.shutdown();
    }
  });

  it('in development the answer names each check with its time, note and (redacted) error', async () => {
    const { application, later } = await boot({ env: { NODE_ENV: 'development' } });
    const kernel = createHttpKernel(application);
    try {
      state.database = 'down';
      const response = await kernel.request('/up/ready');
      expect(response.status).toBe(503);
      const body = (await response.json()) as { status: string; checks: { name: string; status: string; ms: number; note?: string; error?: string }[] };
      expect(body.status).toBe('failing');
      expect(body.checks.map(({ name, status }) => ({ name, status }))).toEqual([
        { name: 'database', status: 'failing' },
        { name: 'storage', status: 'ok' },
      ]);
      expect(body.checks[0]!.error).toBe('connect ECONNREFUSED 127.0.0.1:5432, password=[redacted]');
      expect(body.checks[1]!.ms).toBeTypeOf('number');

      state.database = 'ok';
      later();
      const ok = (await (await kernel.request('/up/ready')).json()) as typeof body;
      expect(ok.checks[0]).toMatchObject({ name: 'database', status: 'ok', note: 'default' });
    } finally {
      await application.shutdown();
    }
  });

  it('from the stop signal on /up/ready answers 503 "draining" while /up stays 200 (SHUTDOWN_DELAY); both 503 once it closes', async () => {
    state.database = 'ok';
    const { application } = await boot();
    const kernel = createHttpKernel(application);
    try {
      expect((await kernel.request('/up')).status).toBe(200);
      expect((await kernel.request('/up/ready')).status).toBe(200);
      // SIGTERM: not ready any more — the cached "ok" of a moment ago does not count — but alive and answering.
      application.container.make(ServerClosing).drain();
      const ready = await kernel.request('/up/ready');
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: 'draining' });
      expect((await kernel.request('/up')).status).toBe(200);
      expect((await kernel.request('/hello')).status).toBe(200);
      application.container.make(ServerClosing).close();
      expect((await kernel.request('/up')).status).toBe(503);
      const closed = await kernel.request('/up/ready');
      expect(closed.status).toBe(503);
      expect(await closed.json()).toEqual({ status: 'draining' });
    } finally {
      await application.shutdown();
    }
  });

  it('probes at the same time share one run of the checks — and the result serves every probe for a second', async () => {
    state.database = 'ok';
    state.runs = 0;
    const { application, later } = await boot();
    const kernel = createHttpKernel(application);
    try {
      const answers = await Promise.all([kernel.request('/up/ready'), kernel.request('/up/ready'), kernel.request('/up/ready')]);
      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
      expect(state.runs).toBe(1);
      // A flood of probes one after the other: one run a second, not one each.
      for (let n = 0; n < 5; n++) expect((await kernel.request('/up/ready')).status).toBe(200);
      expect(state.runs).toBe(1);
      // A failing result is kept just as long — then the next probe runs the checks again.
      later();
      state.database = 'down';
      expect((await kernel.request('/up/ready')).status).toBe(503);
      expect(state.runs).toBe(2);
      state.database = 'ok';
      expect((await kernel.request('/up/ready')).status).toBe(503);
      expect(state.runs).toBe(2);
      later();
      expect((await kernel.request('/up/ready')).status).toBe(200);
      expect(state.runs).toBe(3);
    } finally {
      await application.shutdown();
    }
  });

  it('HEALTH_PATH moves them (or turns them off); an app route on a health path fails the start', async () => {
    state.database = 'ok';
    const moved = await boot({ env: { HEALTH_PATH: '/healthz' } });
    const kernel = createHttpKernel(moved.application);
    expect((await kernel.request('/healthz')).status).toBe(200);
    expect((await kernel.request('/healthz/ready')).status).toBe(200);
    expect((await kernel.request('/up')).status).toBe(404);
    await moved.application.shutdown();

    const ownUp = openRoutes((Route) => void Route.get('/up', () => ({ mine: true })).name('status'));
    const off = await boot({ env: { HEALTH_PATH: 'off' }, routes: ownUp });
    expect(await (await createHttpKernel(off.application).request('/up')).json()).toEqual({ mine: true });
    await off.application.shutdown();

    const clash = await boot({ routes: ownUp });
    expect(() => createHttpKernel(clash.application)).toThrow(
      'The route "status" (GET /up) is where the health check answers — it would never be reached. Give the route another path, or move the health check: HEALTH_PATH=/healthz (or HEALTH_PATH=off).',
    );
    await clash.application.shutdown();

    await expect(boot({ env: { HEALTH_PATH: 'up/' } })).rejects.toThrow('Expected a path like /up or /healthz (no trailing slash), or off');
  });
});
