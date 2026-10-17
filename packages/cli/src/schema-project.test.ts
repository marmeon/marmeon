import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { marmeon, repo } from './__fixtures__/cli.js';
import { tempDir } from '../../../scripts/test/temp-dir.js';

describe('marmeon schema:project (the schema projection of the migrations)', { timeout: 60_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  function app(): string {
    const dir = realpathSync(tempDir('marmeon-project-'));
    cpSync(blank, dir, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(dir, 'node_modules'), 'dir');
    mkdirSync(join(dir, 'storage'));
    return dir;
  }

  it('writes .marmeon/schema.json with the tables of the migrations, and is hidden from the list', () => {
    const dir = app();
    const { code, stdout } = marmeon(dir, ['schema:project']);
    expect(code).toBe(0);
    expect(stdout).toContain('→ .marmeon/schema.json');
    const file = JSON.parse(readFileSync(join(dir, '.marmeon/schema.json'), 'utf8')) as { format: number; migrations: unknown[]; tables: Record<string, unknown> };
    expect(file.format).toBe(1);
    expect(file.migrations).toHaveLength(1);
    expect(Object.keys(file.tables)).toEqual(['jobs', 'failed_jobs']);
    expect(marmeon(dir, ['list']).stdout).not.toContain('schema:project');
  });

  it('stops marmeon build when two migrations create the same table', () => {
    const dir = app();
    writeFileSync(join(dir, 'modules/system/migrations/2026_10_04_000000_create_jobs_again.ts'), "export default { up(schema) { schema.create('jobs', (t) => { t.id(); }); } };\n");
    const { code, stderr } = marmeon(dir, ['build', '--no-typecheck']);
    expect(code).toBe(1);
    expect(stderr).toContain('creates table "jobs"');
    expect(stderr).toContain('Not built: marmeon schema:project failed');
    expect(existsSync(join(dir, 'dist'))).toBe(false);
    expect(existsSync(join(dir, '.marmeon/schema.json'))).toBe(false);
  });

  /** A copy of the blank app whose `node_modules` has every package but `@marmeon/database`. */
  function appWithoutDatabase(migrations: boolean): string {
    const dir = realpathSync(tempDir('marmeon-project-'));
    cpSync(blank, dir, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    mkdirSync(join(dir, 'node_modules/@marmeon'), { recursive: true });
    for (const entry of readdirSync(join(blank, 'node_modules'))) if (entry !== '@marmeon') symlinkSync(join(blank, 'node_modules', entry), join(dir, 'node_modules', entry));
    for (const entry of readdirSync(join(blank, 'node_modules/@marmeon'))) if (entry !== 'database') symlinkSync(join(blank, 'node_modules/@marmeon', entry), join(dir, 'node_modules/@marmeon', entry));
    mkdirSync(join(dir, 'storage'));
    if (!migrations) writeFileSync(join(dir, 'modules/system/index.ts'), "import { defineModule } from '@marmeon/core';\nexport default defineModule({ name: 'system' });\n");
    return dir;
  }

  it('does nothing in an app without @marmeon/database and without migrations', () => {
    const dir = appWithoutDatabase(false);
    const { code } = marmeon(dir, ['schema:project']);
    expect(code).toBe(0);
    expect(existsSync(join(dir, '.marmeon/schema.json'))).toBe(false);
  });

  it('fails in an app with migrations but without @marmeon/database, and says what to add', () => {
    const dir = appWithoutDatabase(true);
    const { code, stderr } = marmeon(dir, ['schema:project']);
    expect(code).toBe(1);
    expect(stderr).toContain('add @marmeon/database as a dependency of the app');
  });

  it('always computes the schema again: a file with altered tables and matching hashes is written over', () => {
    const dir = app();
    expect(marmeon(dir, ['schema:project']).code).toBe(0);
    const path = join(dir, '.marmeon/schema.json');
    const original = readFileSync(path, 'utf8');
    const altered = JSON.parse(original) as { tables: Record<string, unknown> };
    altered.tables = {};
    writeFileSync(path, JSON.stringify(altered));

    expect(marmeon(dir, ['schema:project']).code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it.skipIf(process.getuid?.() === 0)('fails when .marmeon cannot be written and an earlier schema.json remains, and only warns when none does', () => {
    const lock = (dir: string) => {
      chmodSync(join(dir, '.marmeon'), 0o500);
      onTestFinished(() => chmodSync(join(dir, '.marmeon'), 0o700));
    };
    const stale = app();
    expect(marmeon(stale, ['schema:project']).code).toBe(0);
    writeFileSync(join(stale, '.marmeon/schema.json'), '{}');
    lock(stale);
    const failed = marmeon(stale, ['schema:project']);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('remove .marmeon/schema.json or make .marmeon writable');

    const none = app();
    mkdirSync(join(none, '.marmeon'));
    lock(none);
    const warned = marmeon(none, ['schema:project']);
    expect(warned.code).toBe(0);
    expect(warned.stderr).toContain('cannot be written here (and none exists)');
  });
});
