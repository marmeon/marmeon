import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MakeUploadsTableCommand, UPLOADS_MIGRATION } from './uploads/commands.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

function run(root: string, options: Record<string, string> = {}) {
  const lines: string[] = [];
  const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
  return { lines, input: { root, args: [], options, output, spawn: async () => 0 } as never };
}

describe('make:uploads-table', () => {
  it('writes the migration of temporary_uploads into the system module, next to the cache and session tables', async () => {
    const root = tempDir('marmeon-uploads-table-');
    mkdirSync(join(root, 'modules/system/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/system/index.ts'), "export default defineModule({ name: 'system', migrations: new URL('./migrations/', import.meta.url) });");
    writeFileSync(join(root, 'modules/system/migrations/2026_10_02_195920_create_cache_table.ts'), '');

    const first = run(root);
    expect(await new MakeUploadsTableCommand().handle(first.input)).toBe(0);
    const migration = readdirSync(join(root, 'modules/system/migrations')).find((file) => file.endsWith('_create_temporary_uploads_table.ts'))!;
    expect(migration).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_temporary_uploads_table\.ts$/);
    const contents = readFileSync(join(root, 'modules/system/migrations', migration), 'utf8');
    // Exactly the file the package's own tests migrate with; the table follows UPLOADS_CONNECTION (infrastructure).
    expect(contents).toBe(readFileSync(UPLOADS_MIGRATION, 'utf8'));
    expect(contents).toContain('connection: uploadsTableConnection');
    expect(first.lines).toEqual([`✓ Created modules/system/migrations/${migration}`, 'Then: marmeon migrate']);

    const again = run(root);
    expect(await new MakeUploadsTableCommand().handle(again.input)).toBe(1);
    expect(again.lines).toEqual([`✗ modules/system/migrations/${migration} already exists — the temporary_uploads table has its migration.`]);
  });
});
