import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { typeGenerator } from '../__fixtures__/databases.ts';
import { DbTypesCommand } from './db-types.ts';

const modules = [{ name: 'blog', migrations: new URL('../__fixtures__/migrations/blog/', import.meta.url) }];

describe('DbTypesCommand --check', { timeout: 30_000 }, () => {
  it('passes a current file and names a migration or exposes as the cause of a stale one', async () => {
    const root = workspaceTempDir('marmeon-db-types-command-');
    const generator = typeGenerator({ root, modules, container: { has: () => false } } as unknown as Application);
    const lines: string[] = [];
    const output = { success: (m: string) => lines.push(`ok ${m}`), error: (m: string) => lines.push(`err ${m}`), warn: () => {}, line: () => {} };
    const run = () => new DbTypesCommand(generator).handle({ root, args: [], options: { check: true }, output } as unknown as CommandInput);

    await generator.write();
    expect(await run()).toBe(0);

    const { source } = await generator.render();
    writeFileSync(join(root, 'bootstrap/database.d.ts'), source.replace('articles', 'posts_old'));
    expect(await run()).toBe(1);
    expect(lines.at(-1)).toBe("err bootstrap/database.d.ts is out of date — a migration or a module's `exposes` changed. Run: marmeon db:types");
  });
});
