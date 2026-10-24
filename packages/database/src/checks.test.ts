import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Application } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { typeGenerator } from './__fixtures__/databases.ts';
import { DbTypesCheck } from './checks.ts';

const modules = [{ name: 'blog', migrations: new URL('./__fixtures__/migrations/blog/', import.meta.url) }];

describe('DbTypesCheck', { timeout: 30_000 }, () => {
  it('is named db-types and runs with the booted app', () => {
    expect([DbTypesCheck.check, DbTypesCheck.phase]).toEqual(['db-types', 'run']);
  });

  it('fails a missing file, passes a current one, and fails a stale one with the command that fixes it', async () => {
    const root = workspaceTempDir('marmeon-db-types-check-');
    const app = { root, modules, container: { has: () => false } } as unknown as Application;
    const generator = typeGenerator(app);
    const check = new DbTypesCheck(generator, app);
    const file = join(root, 'bootstrap/database.d.ts');

    expect(await check.handle()).toEqual([{ severity: 'error', message: 'bootstrap/database.d.ts does not exist', file: 'bootstrap/database.d.ts', fix: 'marmeon db:types' }]);
    await generator.write();
    expect(await check.handle()).toEqual([]);

    const { source } = await generator.render();
    writeFileSync(file, source.replace('articles', 'posts_old'));
    expect(await check.handle()).toEqual([{ severity: 'error', message: 'bootstrap/database.d.ts is out of date', file: 'bootstrap/database.d.ts', fix: 'marmeon db:types' }]);

    writeFileSync(file, source.replace('@marmeon-format 2', '@marmeon-format 9'));
    expect(await check.handle()).toMatchObject([{ severity: 'error', message: expect.stringContaining('newer version of Marmeon'), code: 'D7' }]);

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source.replace('// @marmeon-format 2\n', ''));
    expect(await check.handle()).toMatchObject([{ severity: 'error', message: expect.stringContaining('another version of Marmeon'), code: 'D7', fix: 'marmeon db:types' }]);
  });

  it('needs no database and runs in production too', async () => {
    const root = workspaceTempDir('marmeon-db-types-prod-');
    const app = { root, modules, container: { has: () => false } } as unknown as Application;
    const generator = typeGenerator(app, 'pgsql');
    await generator.write();
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(await new DbTypesCheck(generator, app).handle()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects with the reason of an aborted signal', async () => {
    const root = workspaceTempDir('marmeon-db-types-abort-');
    const app = { root, modules, container: { has: () => false } } as unknown as Application;
    const generator = typeGenerator(app);
    await generator.write();
    const controller = new AbortController();
    controller.abort(new Error('time is up'));
    await expect(generator.isCurrent(controller.signal)).rejects.toThrow('time is up');
    await expect(new DbTypesCheck(generator, app).handle({ signal: controller.signal })).rejects.toThrow('time is up');
    // The generator still works afterwards: nothing was left half open.
    expect(await generator.isCurrent()).toBe(true);
  });
});
