import { ConsoleLogger, createApplication, type Application } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { StorageServiceProvider, UPLOADS_TABLE } from './index.ts';
import { TemporaryUploads } from './uploads/service.ts';

/** Postgres runs when `MARMEON_TEST_PGSQL_URL` is set (`pnpm test:pgsql`). */
const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
const silent = Object.assign(new ConsoleLogger(), { debug() {}, info() {}, warn() {}, error() {} });

class Rollback extends Error {}

/**
 * The table of temporary uploads is infrastructure: the provider writes it on its own connection — on Postgres a pool of
 * its own — never in the app's transaction. A token used inside a transaction that rolls back stays used: a rollback never makes
 * a second `store()` of the same upload possible. (Not isolated like a test app's database: a real pool, a real transaction.)
 */
describe.skipIf(!PGSQL_URL)('temporary uploads on Postgres, beside the app’s transactions', () => {
  const name = `marmeon_test_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: silent });
  let app: Application;

  beforeAll(async () => {
    await sql`create database ${sql.id(name)}`.execute(admin.get());
    const url = new URL(PGSQL_URL!);
    url.pathname = `/${name}`;
    app = await createApplication({
      root: freshDirectory(),
      discover: false,
      providers: [EncryptionServiceProvider, DatabaseServiceProvider, HttpServiceProvider, StorageServiceProvider],
    }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent', DB_MANAGED: 'false', DB_DRIVER: 'pgsql', DB_URL: url.href, UPLOADS_CONNECTION: 'default' } });
    await app.container
      .make(Connections)
      .get()
      .schema.createTable(UPLOADS_TABLE)
      .addColumn('id', 'varchar(36)', (c) => c.primaryKey())
      .addColumn('session', 'varchar(64)', (c) => c.notNull())
      .addColumn('route', 'varchar(200)', (c) => c.notNull())
      .addColumn('field', 'varchar(200)', (c) => c.notNull())
      .addColumn('disk', 'varchar(100)', (c) => c.notNull())
      .addColumn('key', 'varchar(255)', (c) => c.notNull())
      .addColumn('name', 'varchar(255)', (c) => c.notNull())
      .addColumn('max_bytes', 'bigint', (c) => c.notNull())
      .addColumn('size', 'bigint')
      .addColumn('created_at', 'bigint', (c) => c.notNull())
      .addColumn('expires_at', 'bigint', (c) => c.notNull())
      .addColumn('started_at', 'bigint')
      .addColumn('uploaded_at', 'bigint')
      .addColumn('consumed_at', 'bigint')
      .execute();
  });

  afterAll(async () => {
    await app?.shutdown();
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin.get());
    await admin.destroy();
    removeDirectories();
  });

  it('a token used inside a transaction that rolls back is still used afterwards', async () => {
    const uploads = app.container.make(TemporaryUploads);
    const { token } = await uploads.target({ route: 'avatar.update', field: 'avatar', rule: { maxBytes: 100, mime: undefined }, session: 's', name: 'a.png', size: 10 });
    const id = token.slice(3, 39);
    await expect(
      app.container.make(Connections).transaction(async () => {
        expect(await uploads.consume(id)).toBe(true);
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);
    expect(await uploads.consume(id)).toBe(false);
  });

  it('40 targets at once on the real pool leave at most 20 open uploads for the session', async () => {
    const uploads = app.container.make(TemporaryUploads);
    const answers = await Promise.allSettled(
      Array.from({ length: 40 }, () => uploads.target({ route: 'avatar.update', field: 'avatar', rule: { maxBytes: 100, mime: undefined }, session: 'racing', name: 'a.png', size: 10 })),
    );
    for (const answer of answers) if (answer.status === 'rejected') expect((answer.reason as { status?: number }).status).toBe(429);
    const { rows } = await sql<{ n: string }>`select count(*) as n from ${sql.table(UPLOADS_TABLE)} where session = 'racing'`.execute(app.container.make(Connections).get());
    expect(Number(rows[0]!.n)).toBeLessThanOrEqual(20);
    expect(answers.filter((answer) => answer.status === 'fulfilled').length).toBe(Number(rows[0]!.n));
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });
});
