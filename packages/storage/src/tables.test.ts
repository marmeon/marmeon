import { readdirSync, readFileSync } from 'node:fs';
import { createApplication, HealthChecks, Logger } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, Schema } from '@marmeon/database';
import { SchemaRequirements } from '@marmeon/database/internal';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { StorageServiceProvider, TemporaryUploads } from './index.ts';
import { UPLOADS_MIGRATION } from './uploads/commands.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;

describe('the temporary_uploads table', () => {
  const providers = [EncryptionServiceProvider, DatabaseServiceProvider, HttpServiceProvider, StorageServiceProvider];
  const env = { APP_KEY: generateKey(), DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', LOG_LEVEL: 'silent' };

  const problems = async (prepare: (schema: Schema) => Promise<void>) => {
    await using application = await createApplication({ root: tempDir('marmeon-uploads-ready-'), discover: false, providers }, { env, override: (container) => container.instance(Logger, silent) });
    await application.container.make(Migrator).migrate();
    const connections = application.container.make(Connections);
    await prepare(new Schema(connections.get(), connections.options().driver));
    const report = await application.container.make(HealthChecks).run(application.container);
    return report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []));
  };

  it('stays ready when the table is missing, and an upload says which command makes it', async () => {
    expect(await problems(async () => {})).toEqual([]);
    await using application = await createApplication({ root: tempDir('marmeon-uploads-ready-'), discover: false, providers }, { env, override: (container) => container.instance(Logger, silent) });
    await application.container.make(Migrator).migrate();
    const uploads = application.container.make(TemporaryUploads);
    await expect(uploads.target({ route: 'avatar.update', field: 'avatar', rule: { maxBytes: 100, mime: undefined }, session: 's', name: 'a.png', size: 10 })).rejects.toThrow(/temporary_uploads is missing — run marmeon make:uploads-table, then marmeon migrate/);
  });

  it('is red when the table lacks a column', async () => {
    const messages = await problems(async (schema) => {
      await schema.create('temporary_uploads', (table) => {
        table.string('id', 36).primary();
      });
    });
    expect(messages).toContainEqual(expect.stringMatching(/temporary_uploads lacks session, .*consumed_at — run marmeon make:upgrade-migrations/));
  });

  it('is a table readiness waits for once uploads are set up', async () => {
    await using application = await createApplication({ root: tempDir('marmeon-uploads-ready-'), discover: false, providers }, { env, override: (container) => container.instance(Logger, silent) });
    expect(application.container.make(SchemaRequirements).all().map((requirement) => requirement.table)).toEqual(['temporary_uploads']);
  });
});

describe('the migrations in the apps', () => {
  it("the web app's table of the uploads comes from the stub, the blank app's and the starter's have none", () => {
    const repo = new URL('../../../', import.meta.url);
    const filesOf = (dir: string) => readdirSync(new URL(dir, repo)).filter((file) => /temporary_uploads_table/.test(file) && !file.includes('_index_'));
    const web = 'apps/web-app/modules/system/migrations/';
    const files = filesOf(web);
    expect(files).toEqual(['2026_10_03_111422_create_temporary_uploads_table.ts']);
    expect(readFileSync(new URL(web + files[0], repo), 'utf8')).toBe(readFileSync(UPLOADS_MIGRATION, 'utf8'));
    for (const dir of ['apps/blank-app/modules/system/migrations/', 'packages/create-marmeon/template/base/modules/system/migrations/']) expect(filesOf(dir), dir).toEqual([]);
  });
});
