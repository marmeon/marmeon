import { createApplication, HealthChecks, Logger } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { RedisConnections, RedisServiceProvider } from './index.ts';

/** Redis runs when `MARMEON_TEST_REDIS_URL` is set (`pnpm test:redis`). */
const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const boot = (url: string) =>
  createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { REDIS_URL: url, REDIS_PREFIX: `marmeon-test-${crypto.randomUUID().slice(0, 8)}:` },
    providers: [RedisServiceProvider],
    override: (container) => container.instance(Logger, silent),
  });

describe('the redis health check', () => {
  it('checks only the connections the app uses — a configured Redis nobody talks to is no reason to be "not ready"', async () => {
    await using app = await boot('redis://127.0.0.1:1');
    const report = await app.container.make(HealthChecks).run(app.container);
    expect(report).toMatchObject({ ok: true, checks: [{ name: 'redis', status: 'ok', note: 'no connection in use' }] });
  });

  it('a connection in use that does not answer: failing', async () => {
    await using app = await boot('redis://127.0.0.1:1');
    app.container.make(RedisConnections).get();
    const report = await app.container.make(HealthChecks).run(app.container);
    expect(report.checks[0]).toMatchObject({ name: 'redis', status: 'failing' });
    expect((report.checks[0]!.error as Error).message).toMatch(/^The Redis connection "default" failed: /);
  });

  it.skipIf(!REDIS_URL)('a connection in use answers PING', async () => {
    await using app = await boot(REDIS_URL!);
    app.container.make(RedisConnections).get();
    const report = await app.container.make(HealthChecks).run(app.container);
    expect(report).toMatchObject({ ok: true, checks: [{ name: 'redis', status: 'ok', note: 'default' }] });
  });
});
