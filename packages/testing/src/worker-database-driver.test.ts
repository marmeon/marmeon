import { existsSync, readdirSync } from 'node:fs';
import { defineConfig, env } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { workerDatabase } from './database.ts';

// The configuration of today never names another driver; the refusal is for the one that does.
vi.mock('@marmeon/database/internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marmeon/database/internal')>()),
  DatabaseConfig: defineConfig('database', { env: env({}), resolve: () => ({ default: { driver: 'mysql', url: 'mysql://x@127.0.0.1/shop' } }) }),
}));

describe('workerDatabase() on a driver it has no SQL for', () => {
  it('refuses with D29 before a directory or a database is made', async () => {
    const root = workspaceTempDir('marmeon-testing-db-');
    await expect(workerDatabase(root, {})).rejects.toThrow(/\[marmeon:D29\] A test app with a database needs a sqlite or pgsql connection, not "mysql"/);
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(`${root}/storage`)).toBe(false);
  });
});
