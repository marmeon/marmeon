import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { tempDir, workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { typeGenerator } from '../__fixtures__/databases.ts';

const modules = [{ name: 'blog', migrations: new URL('../__fixtures__/migrations/blog/', import.meta.url) }];

describe('TypeGenerator.write — the file is a link', { timeout: 30_000 }, () => {
  const generatorIn = (root: string) => typeGenerator({ root, modules, container: { has: () => false } } as unknown as Application);

  it('rewrites a regular file', async () => {
    const root = workspaceTempDir('marmeon-db-types-link-');
    mkdirSync(join(root, 'bootstrap'));
    writeFileSync(join(root, 'bootstrap/database.d.ts'), 'old');
    expect((await generatorIn(root).write()).changed).toBe(true);
    expect(readFileSync(join(root, 'bootstrap/database.d.ts'), 'utf8')).toContain('articles');
  });

  it('refuses bootstrap/database.d.ts as a link out of the project and leaves the file it points at', async () => {
    const root = realpathSync(workspaceTempDir('marmeon-db-types-link-'));
    const outside = realpathSync(tempDir('marmeon-db-types-outside-'));
    writeFileSync(join(outside, 'kept.d.ts'), 'untouched');
    mkdirSync(join(root, 'bootstrap'));
    symlinkSync(join(outside, 'kept.d.ts'), join(root, 'bootstrap/database.d.ts'));
    await expect(generatorIn(root).write()).rejects.toThrow(/bootstrap\/database\.d\.ts leads out of the project.*Nothing was written/);
    expect(readFileSync(join(outside, 'kept.d.ts'), 'utf8')).toBe('untouched');
  });

  it('refuses a link out of the project to a file with the same content instead of calling it up to date', async () => {
    const root = realpathSync(workspaceTempDir('marmeon-db-types-link-'));
    const outside = realpathSync(tempDir('marmeon-db-types-outside-'));
    const generator = generatorIn(root);
    writeFileSync(join(outside, 'same.d.ts'), (await generator.render()).source);
    mkdirSync(join(root, 'bootstrap'));
    symlinkSync(join(outside, 'same.d.ts'), join(root, 'bootstrap/database.d.ts'));
    await expect(generator.write()).rejects.toThrow(/leads out of the project/);
  });

  it('isCurrent refuses a link out of the project instead of reading it', async () => {
    const root = realpathSync(workspaceTempDir('marmeon-db-types-link-'));
    const outside = realpathSync(tempDir('marmeon-db-types-outside-'));
    const generator = generatorIn(root);
    writeFileSync(join(outside, 'same.d.ts'), (await generator.render()).source);
    mkdirSync(join(root, 'bootstrap'));
    symlinkSync(join(outside, 'same.d.ts'), join(root, 'bootstrap/database.d.ts'));
    await expect(generator.isCurrent()).rejects.toThrow(/leads out of the project/);
  });
});
