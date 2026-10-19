import { readdirSync, readFileSync } from 'node:fs';
import { createApplication, Logger } from '@marmeon/core';
import { SchemaRequirements } from '@marmeon/database';
import { DatabaseServiceProvider } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { silent } from './__fixtures__/stores.ts';
import { CACHE_MIGRATION } from './commands/make-cache-table.ts';
import { CacheServiceProvider } from './index.ts';

async function appWith(env: Record<string, string>) {
  return createApplication(
    { root: '/tmp', discover: false, providers: [DatabaseServiceProvider, CacheServiceProvider] },
    { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', ...env }, override: (container) => container.instance(Logger, silent) },
  );
}

describe('the tables readiness waits for', () => {
  const required = async (env: Record<string, string>) => {
    await using application = await appWith(env);
    return application.container.make(SchemaRequirements).all().map((requirement) => requirement.table);
  };

  it('are both for the database cache', async () => {
    expect(await required({ CACHE_DRIVER: 'database' })).toEqual(['cache', 'cache_locks']);
  });

  it('are none for any other driver', async () => {
    expect(await required({ CACHE_DRIVER: 'memory' })).toEqual([]);
    expect(await required({ CACHE_DRIVER: 'file' })).toEqual([]);
  });
});

describe('the migrations in the apps', () => {
  it("the web app's tables of the cache come from the stub, the blank app's and the starter's have none", () => {
    const repo = new URL('../../../', import.meta.url);
    const filesOf = (dir: string) => readdirSync(new URL(dir, repo)).filter((file) => /cache_table/.test(file));
    const web = 'apps/web-app/modules/system/migrations/';
    const files = filesOf(web);
    expect(files).toEqual(['2026_10_02_195920_create_cache_table.ts']);
    expect(readFileSync(new URL(web + files[0], repo), 'utf8')).toBe(readFileSync(CACHE_MIGRATION, 'utf8'));
    for (const dir of ['apps/blank-app/modules/system/migrations/', 'packages/create-marmeon/template/base/modules/system/migrations/']) expect(filesOf(dir), dir).toEqual([]);
  });
});
