import { join } from 'node:path';
import { Clock, createApplication } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDirectory, removeDirectories } from './__fixtures__/disks.ts';
import { defineStorage } from './config.ts';
import { StorageServiceProvider, TemporaryUploads, UPLOADS_TABLE } from './index.ts';

afterAll(removeDirectories);

const MB = 1024 * 1024;

/** The app's uploads, booted from the environment: the units of the variables meet the clock here. */
async function boot(env: Record<string, string>) {
  const base = freshDirectory();
  const clock = new TestClock();
  clock.freeze();
  const app = await createApplication({
    root: base,
    discover: false,
    config: [defineStorage({ default: 'uploads', disks: { uploads: { driver: 'local', root: join(base, 'uploads') } } })],
    providers: [EncryptionServiceProvider, DatabaseServiceProvider, HttpServiceProvider, StorageServiceProvider],
  }, {
    env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', UPLOADS_CONNECTION: 'default', ...env },
    override: (container) => container.instance(Clock, clock),
  });
  await sql`
    create table ${sql.table(UPLOADS_TABLE)} (
      id varchar(36) primary key, session varchar(64) not null, route varchar(200) not null, field varchar(200) not null,
      disk varchar(100) not null, key varchar(255) not null, name varchar(255) not null, max_bytes bigint not null, size bigint,
      created_at bigint not null, expires_at bigint not null, started_at bigint, uploaded_at bigint, consumed_at bigint
    )
  `.execute(app.container.make(Connections).get());
  const target = async () => {
    const answer = await app.container.make(TemporaryUploads).target({ route: 'avatar.update', field: 'avatar', rule: { maxBytes: 5 * MB, mime: undefined }, session: 'a', name: 'a.png', size: 10 });
    const [row] = (await app.container.make(Connections).get().selectFrom(UPLOADS_TABLE as never).selectAll().execute()) as { created_at: number; expires_at: number }[];
    return { url: new URL(answer.upload.url!, 'http://localhost'), row: row! };
  };
  return { app, clock, target };
}

describe('the upload variables in minutes, as the uploads use them', () => {
  it('UPLOADS_LIFETIME_MINUTES is the time a token works, in minutes', async () => {
    const { app, target } = await boot({ UPLOADS_LIFETIME_MINUTES: '3' });
    const { row } = await target();
    expect(row.expires_at - row.created_at).toBe(3 * 60_000);
    await app.shutdown();
  });

  it('UPLOADS_SEND_WITHIN_MINUTES is the time the browser has to send the file, in minutes', async () => {
    const { app, clock, target } = await boot({ UPLOADS_SEND_WITHIN_MINUTES: '2' });
    const { url } = await target();
    expect(Number(url.searchParams.get('expires'))).toBe(Math.floor(clock.now() / 1000) + 2 * 60);
    await app.shutdown();
  });
});
