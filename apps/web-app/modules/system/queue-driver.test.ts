import { QueueConnections } from '@marmeon/queue';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

describe('the app\'s own queue driver', () => {
  it('QUEUE_DRIVER=scratch selects it; it keeps and hands out jobs', async () => {
    const app = await createTestApp(application, { env: { QUEUE_DRIVER: 'scratch' } });
    const connections = app.make(QueueConnections);
    expect(connections.options('scratch')).toEqual({ driver: 'custom', queue: 'default', retryAfter: 90 });
    const driver = connections.driver('scratch');
    await driver.push('default', '{}', 0);
    expect(await driver.size('default')).toBe(1);
    const job = await driver.reserve(['default']);
    expect(job).toMatchObject({ attempts: 1 });
    expect(await driver.ack(job!)).toBe(true);
    expect(await driver.size('default')).toBe(0);
    await app.close();
  });

  it('is there beside the built-in connections without being the default', async () => {
    const app = await createTestApp(application);
    const connections = app.make(QueueConnections);
    expect(connections.names()).toContain('scratch');
    expect(connections.default).toBe('database');
    await app.close();
  });
});
