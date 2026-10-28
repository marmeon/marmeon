import { join } from 'node:path';
import { defineModule, type ApplicationDefinition, type Logger } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { DatabaseConfig } from '@marmeon/database/internal';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp } from './index.ts';

// Its own file on purpose: the app in each of these tests is the first one with a database that the file opens, so the worker's
// database has not been prepared yet. Without the check before the preparation, the preparation would delete the file the
// override points at.

const root = workspaceTempDir('marmeon-testing-guard-');
const definition: ApplicationDefinition = {
  root,
  discover: false,
  providers: [EncryptionServiceProvider, DatabaseServiceProvider],
  modules: [defineModule({ name: 'notes', migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
};
const env = { APP_KEY: generateKey(), DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:' };
const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger } as unknown as Logger;

describe('a test app whose connection is not the worker database', () => {
  for (const database of ['refresh', 'isolated'] as const) {
    it(`is refused with database: '${database}', and the other database is left alone`, async () => {
      const foreign = new Connections({ connections: { default: { driver: 'sqlite', database: join(root, `other-${database}.sqlite`) } }, root, logger });
      try {
        await sql`create table precious (id integer primary key)`.execute(foreign.get());
        await sql`insert into precious (id) values (1)`.execute(foreign.get());
        await expect(
          createTestApp(definition, { env, database, override: (container) => container.instance(DatabaseConfig, { default: foreign.options() }) }),
        ).rejects.toThrow("must use the worker's own test database");
        expect((await sql`select id from precious`.execute(foreign.get())).rows).toHaveLength(1);
      } finally {
        await foreign.destroy();
      }
    });
  }
});
