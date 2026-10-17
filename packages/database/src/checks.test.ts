import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Application } from '@marmeon/core';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { freshConnections, silent } from './__fixtures__/databases.ts';
import { DbTypesCheck } from './checks.ts';
import { TypeGenerator } from './index.ts';

const modules = [{ name: 'blog', migrations: new URL('./__fixtures__/migrations/blog/', import.meta.url) }];

describe('DbTypesCheck', { timeout: 30_000 }, () => {
  it('is named db-types and runs with the booted app', () => {
    expect([DbTypesCheck.check, DbTypesCheck.phase]).toEqual(['db-types', 'run']);
  });

  it('fails a missing file, passes a current one, and fails a stale one with the command that fixes it', async () => {
    const root = tempDir('marmeon-db-types-check-');
    const { connections, close } = await freshConnections('sqlite');
    try {
      const app = { root, modules, container: { has: () => false } } as unknown as Application;
      const generator = new TypeGenerator(app, connections, silent);
      const check = new DbTypesCheck(generator, app);
      const file = join(root, 'bootstrap/database.d.ts');

      expect(await check.handle()).toEqual([{ severity: 'error', message: 'bootstrap/database.d.ts does not exist', file: 'bootstrap/database.d.ts', fix: 'marmeon db:types' }]);
      await generator.write();
      expect(await check.handle()).toEqual([]);

      const { source } = await generator.render();
      writeFileSync(file, source.replace('articles', 'posts_old'));
      expect(await check.handle()).toEqual([{ severity: 'error', message: 'bootstrap/database.d.ts is out of date', file: 'bootstrap/database.d.ts', fix: 'marmeon db:types' }]);

      writeFileSync(file, source.replace('@marmeon-format 1', '@marmeon-format 9'));
      expect(await check.handle()).toMatchObject([{ severity: 'error', message: expect.stringContaining('newer version of Marmeon'), code: 'D7' }]);

      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source.replace('// @marmeon-format 1\n', ''));
      expect(await check.handle()).toMatchObject([{ severity: 'error', message: expect.stringContaining('another version of Marmeon'), code: 'D7', fix: 'marmeon db:types' }]);
    } finally {
      await close();
    }
  });

  it('skips on a server database outside development and test, and never touches the server', async () => {
    const root = tempDir('marmeon-db-types-skip-');
    const get = vi.fn();
    const server = { options: () => ({ driver: 'pgsql', url: 'postgres://u:p@localhost/db' }), get };
    const app = { root, modules, container: { has: () => false } } as unknown as Application;
    const generator = new TypeGenerator(app, server as never, silent);
    mkdirSync(join(root, 'bootstrap'), { recursive: true });
    writeFileSync(join(root, 'bootstrap/database.d.ts'), '// Generated\n// x\n// @marmeon-format 1\n');
    const check = new DbTypesCheck(generator, app);
    try {
      for (const name of ['production', '', 'staging']) {
        vi.stubEnv('NODE_ENV', name);
        expect(await check.handle()).toMatchObject({ skipped: expect.stringContaining('development and test only') });
      }
    } finally {
      vi.unstubAllEnvs();
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects with the reason of an aborted signal, and leaves nothing open', async () => {
    const root = tempDir('marmeon-db-types-abort-');
    const { connections, close } = await freshConnections('sqlite');
    try {
      const app = { root, modules, container: { has: () => false } } as unknown as Application;
      const generator = new TypeGenerator(app, connections, silent);
      await generator.write();
      const controller = new AbortController();
      controller.abort(new Error('time is up'));
      await expect(generator.isCurrent(controller.signal)).rejects.toThrow('time is up');
      await expect(new DbTypesCheck(generator, app).handle({ signal: controller.signal })).rejects.toThrow('time is up');
      // The generator still works afterwards: nothing was left half open.
      expect(await generator.isCurrent()).toBe(true);
    } finally {
      await close();
    }
  });
});
