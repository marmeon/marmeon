import { join } from 'node:path';
import { createApplication, env } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, defineConnection, InfrastructureTransactionError, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { StorageServiceProvider, UPLOADS_TABLE } from './index.ts';
import { TemporaryUploads } from './uploads/service.ts';

afterAll(removeDirectories);

class Rollback extends Error {}

const SystemDatabase = defineConnection('system', {
  env: env({ SYSTEM_DB_DATABASE: env.string().default(':memory:') }),
  resolve: (e) => ({ driver: 'sqlite', database: e.SYSTEM_DB_DATABASE, managed: false }),
});

/** An app on SQLite with the uploads table on `UPLOADS_CONNECTION`, and a token of a fresh upload. */
async function boot(vars: Record<string, string>) {
  const root = freshDirectory();
  const app = await createApplication({
    root,
    discover: false,
    config: [SystemDatabase],
    providers: [EncryptionServiceProvider, DatabaseServiceProvider, HttpServiceProvider, StorageServiceProvider],
  }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', ...vars } });
  const connections = app.container.make(Connections);
  await sql`
    create table ${sql.table(UPLOADS_TABLE)} (
      id varchar(36) primary key, session varchar(64) not null, route varchar(200) not null, field varchar(200) not null,
      disk varchar(100) not null, key varchar(255) not null, name varchar(255) not null, max_bytes bigint not null, size bigint,
      created_at bigint not null, expires_at bigint not null, started_at bigint, uploaded_at bigint, consumed_at bigint
    )
  `.execute(connections.get(vars.UPLOADS_CONNECTION));
  const uploads = app.container.make(TemporaryUploads);
  const { token } = await uploads.target({ route: 'avatar.update', field: 'avatar', rule: { maxBytes: 100, mime: undefined }, session: 's', name: 'a.png', size: 10 });
  return { app, connections, uploads, id: token.slice(3, 39) };
}

// The table is infrastructure: written on its own connection, never in the app's transaction. On Postgres:
// uploads-database.test.ts.
describe('a used token stays used when the transaction around it rolls back, on SQLite', () => {
  it('with the app’s own file as the uploads connection: inside a transaction a loud error — never a silent join', async () => {
    const { app, connections, uploads, id } = await boot({ DB_DATABASE: ':memory:', UPLOADS_CONNECTION: 'default' });
    await expect(connections.transaction(async () => uploads.consume(id))).rejects.toThrow(InfrastructureTransactionError);
    await app.shutdown();
  });

  it('with a file of its own (UPLOADS_CONNECTION=system): after the rollback the token is still used', async () => {
    const root = freshDirectory();
    const { app, connections, uploads, id } = await boot({ DB_DATABASE: join(root, 'database.sqlite'), SYSTEM_DB_DATABASE: join(root, 'system.sqlite'), UPLOADS_CONNECTION: 'system' });
    await expect(
      connections.transaction(async () => {
        expect(await uploads.consume(id)).toBe(true);
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);
    expect(await uploads.consume(id)).toBe(false);
    await app.shutdown();
  });
});
