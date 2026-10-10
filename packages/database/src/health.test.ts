import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication, env, HealthChecks, Logger } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { defineConnection } from './config.ts';
import { Connections } from './connections.ts';
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

describe('the database health check', () => {
  it('is registered by the provider and answers `select 1` on every connection the app uses — never opens one it does not', async () => {
    const file = join(root, 'system.sqlite');
    await using app = await boot([defineConnection('system', { env: env({}), resolve: () => ({ driver: 'sqlite', database: file }) })]);
    expect(app.container.make(HealthChecks).all()).toContain(DatabaseHealthCheck);
    // Configured, but nothing uses it (no cache, no sessions on it): not opened — its SQLite file is not even created.
    const unused = await app.container.make(HealthChecks).run(app.container);
    expect(unused, `checked: ${String(unused.checks[0]?.note)}`).toMatchObject({ ok: true, checks: [{ name: 'database', status: 'ok', note: 'default' }] });
    expect(existsSync(file), 'readiness created the unused SQLite file').toBe(false);
    // A package that keeps its tables there checks the connection when it boots — from then on readiness asks it too.
    app.container.make(Connections).options('system');
    const used = await app.container.make(HealthChecks).run(app.container);
    expect(used).toMatchObject({ ok: true, checks: [{ name: 'database', status: 'ok', note: 'default, system' }] });
  });

  it('fails when one connection is unreachable — and says which', async () => {
    // A Postgres port nobody listens on: refused at once.
    await using app = await boot([defineConnection('reporting', { env: env({}), resolve: () => ({ driver: 'pgsql', url: 'postgres://marmeon:secret@127.0.0.1:1/reporting' }) })]);
    app.container.make(Connections).get('reporting');
    const report = await app.container.make(HealthChecks).run(app.container);
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: 'database', status: 'failing' });
    expect((report.checks[0]!.error as Error).message).toMatch(/^The database connection "reporting" failed: /);
  });
});
