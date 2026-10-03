import { createApplication, HealthChecks, Logger } from '@bespokecore/core';
import { Connections, DatabaseServiceProvider } from '@bespokecore/database';
import { describe, expect, it } from 'vitest';
import { migrate, silent } from './__fixtures__/targets.ts';
import { QueueServiceProvider } from './index.ts';

describe('the queue health check (E126)', () => {
  it('the default connection\'s driver answers: the size of its default queue', async () => {
    await using app = await createApplication({
      root: '/tmp',
      discover: false,
      env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', QUEUE_CONNECTION: 'database' },
      providers: [DatabaseServiceProvider, QueueServiceProvider],
      override: (container) => container.instance(Logger, silent),
    });
    const checks = app.container.make(HealthChecks);
    // Without its table the driver cannot answer.
    const missing = await checks.run(app.container);
    expect(missing.checks.find((check) => check.name === 'queue')).toMatchObject({ status: 'failing' });
    await migrate(app.container.make(Connections));
    const report = await checks.run(app.container);
    expect(report.checks.find((check) => check.name === 'queue')).toMatchObject({ status: 'ok', note: 'database, 0 waiting' });
  });
});
