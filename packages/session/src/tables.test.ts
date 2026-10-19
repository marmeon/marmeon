import { readdirSync, readFileSync } from 'node:fs';
import { createApplication, Logger } from '@marmeon/core';
import { SchemaRequirements } from '@marmeon/database';
import { DatabaseServiceProvider } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { silent } from './__fixtures__/stores.ts';
import { SESSIONS_MIGRATION } from './commands/make-session-table.ts';
import { SessionServiceProvider } from './index.ts';

describe('the table readiness waits for', () => {
  const required = async (env: Record<string, string>) => {
    await using application = await createApplication(
      { root: '/tmp', discover: false, providers: [DatabaseServiceProvider, SessionServiceProvider] },
      { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', ...env }, override: (container) => container.instance(Logger, silent) },
    );
    return application.container.make(SchemaRequirements).all().map((requirement) => requirement.table);
  };

  it('is sessions for the database driver', async () => {
    expect(await required({ SESSION_DRIVER: 'database' })).toEqual(['sessions']);
  });

  it('is none for any other driver', async () => {
    expect(await required({ SESSION_DRIVER: 'memory' })).toEqual([]);
    expect(await required({ SESSION_DRIVER: 'file' })).toEqual([]);
  });
});

describe('the migrations in the apps', () => {
  it("the web app's table of the sessions comes from the stub, the blank app's and the starter's have none", () => {
    const repo = new URL('../../../', import.meta.url);
    const filesOf = (dir: string) => readdirSync(new URL(dir, repo)).filter((file) => /sessions_table/.test(file));
    const web = 'apps/web-app/modules/system/migrations/';
    const files = filesOf(web);
    expect(files).toEqual(['2026_10_02_203103_create_sessions_table.ts']);
    expect(readFileSync(new URL(web + files[0], repo), 'utf8')).toBe(readFileSync(SESSIONS_MIGRATION, 'utf8'));
    for (const dir of ['apps/blank-app/modules/system/migrations/', 'packages/create-marmeon/template/base/modules/system/migrations/']) expect(filesOf(dir), dir).toEqual([]);
  });
});
