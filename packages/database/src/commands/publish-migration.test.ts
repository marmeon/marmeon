import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { publishMigration } from './publish-migration.ts';

function run(root: string) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const code = publishMigration({ root, args: [], options: {}, output } as never, { name: 'create_things_table', contents: '// migration\n', module: 'system' });
  return { code, lines };
}

describe('publishMigration', () => {
  it('leaves a system module whose definition is not written out as it is, and says what to add', () => {
    const root = tempDir('marmeon-publish-migration-');
    mkdirSync(join(root, 'modules/system'), { recursive: true });
    const source = "import { defineModule } from '@marmeon/core';\n\nexport default defineModule(definition);\n";
    writeFileSync(join(root, 'modules/system/index.ts'), source);
    const { code, lines } = run(root);
    expect(code).toBe(0);
    expect(readFileSync(join(root, 'modules/system/index.ts'), 'utf8')).toBe(source);
    expect(lines.some((line) => line.startsWith('! Not registered — ') && line.endsWith('in modules/system/index.ts'))).toBe(true);
    expect(lines).toContain("  add: migrations: new URL('./migrations/', import.meta.url)");
    expect(lines.filter((line) => line.includes(root) && !line.startsWith('✓ Created'))).toEqual([]);
  });
});
