import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication, env, HealthChecks, Logger } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { defineConnection } from './config.ts';
import { Connections } from './connections.ts';
import { DatabaseHealthCheck } from './health.ts';
import { defineMigration } from './migrations/migration.ts';
import { Migrator } from './migrations/migrator.ts';
import { runMigration } from './migrations/run.ts';
import { DatabaseServiceProvider } from './provider.ts';
import { sql } from 'kysely';
import { SchemaRequirements } from './schema-requirements.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const root = tempDir('marmeon-db-health-');
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const boot = (extra: ReturnType<typeof defineConnection>[] = []) =>
  createApplication({
    root,
    discover: false,
    providers: [DatabaseServiceProvider],
    config: extra,
  }, { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: join(root, 'app.sqlite') }, override: (container) => container.instance(Logger, silent) });

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

describe('the secret columns a table is required to have', () => {
  const requirement = (connection: string, table: string) => ({ connection, table, columns: ['id', 'token'], secrets: ['token'] });
  const messageOf = async (app: Awaited<ReturnType<typeof boot>>) => {
    const report = await app.container.make(HealthChecks).run(app.container);
    return { report, message: report.checks[0]!.error instanceof Error ? report.checks[0]!.error.message : '' };
  };

  const keys = (table: string, mark: boolean) =>
    defineMigration({
      up: (schema) =>
        schema.create(table, (t) => {
          t.id();
          const token = t.string('token', 64).nullable();
          if (mark) token.secret();
        }),
    });

  it('are red while the migrations do not mark one, with the way to mark it', async () => {
    await using app = await boot();
    await app.container.make(Migrator).migrate();
    const connections = app.container.make(Connections);
    await runMigration(connections, keys('keys_unmarked', false));
    app.container.make(SchemaRequirements).require(requirement('default', 'keys_unmarked'));
    const { report, message } = await messageOf(app);
    expect(report.ok).toBe(false);
    expect(message).toBe('keys_unmarked has token without the secret() mark — a migration marks the column with .secret() (schema.alter), see docs/migrations.md#how-the-migrator-keeps-track');
  });

  it('are green once the migrations mark them', async () => {
    await using app = await boot();
    await app.container.make(Migrator).migrate();
    const connections = app.container.make(Connections);
    await runMigration(connections, keys('keys_marked', true));
    app.container.make(SchemaRequirements).require(requirement('default', 'keys_marked'));
    expect((await messageOf(app)).report.ok).toBe(true);
  });

  it('are not asked of a connection that is not managed: its migrations are not Marmeon\'s', async () => {
    const file = join(root, 'foreign.sqlite');
    await using app = await boot([defineConnection('foreign', { env: env({}), resolve: () => ({ driver: 'sqlite', database: file, managed: false }) })]);
    await sql`create table keys_foreign (id integer primary key, token varchar(64))`.execute(app.container.make(Connections).get('foreign'));
    app.container.make(SchemaRequirements).require(requirement('foreign', 'keys_foreign'));
    expect((await messageOf(app)).report.ok).toBe(true);
  });
});
