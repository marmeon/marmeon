import { join } from 'node:path';
import { createApplication, HealthChecks, Logger } from '@marmeon/core';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { defineConnection } from './config.ts';
import { DatabaseHealthCheck } from './health.ts';
import { DatabaseServiceProvider } from './provider.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const root = tempDir('marmeon-db-health-');
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const boot = (extra: ReturnType<typeof defineConnection>[] = []) =>
  createApplication({
    root,
    discover: false,
    env: { DB_CONNECTION: 'sqlite', DB_DATABASE: join(root, 'app.sqlite') },
    providers: [DatabaseServiceProvider],
    config: extra,
    override: (container) => container.instance(Logger, silent),
  });

describe('the database health check (E126)', () => {
  it('is registered by the provider and answers `select 1` on every connection', async () => {
    await using app = await boot([defineConnection('system', { env: v.object({}), resolve: () => ({ driver: 'sqlite', database: join(root, 'system.sqlite') }) })]);
    expect(app.container.make(HealthChecks).all()).toContain(DatabaseHealthCheck);
    const report = await app.container.make(HealthChecks).run(app.container);
    expect(report).toMatchObject({ ok: true, checks: [{ name: 'database', status: 'ok', note: 'default, system' }] });
  });

  it('fails when one connection is unreachable — and says which', async () => {
    // A Postgres port nobody listens on: refused at once.
    await using app = await boot([defineConnection('reporting', { env: v.object({}), resolve: () => ({ driver: 'pgsql', url: 'postgres://marmeon:secret@127.0.0.1:1/reporting' }) })]);
    const report = await app.container.make(HealthChecks).run(app.container);
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: 'database', status: 'failing' });
    expect((report.checks[0]!.error as Error).message).toMatch(/^The database connection "reporting" failed: /);
  });
});
