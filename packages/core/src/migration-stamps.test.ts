import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { newestMigration, stampsBehind } from './internal.ts';
import { nextMigrationStamp } from './index.ts';

function app(files: Record<string, string[]> = {}): string {
  const root = tempDir('marmeon-stamps-');
  for (const [module, names] of Object.entries(files)) {
    mkdirSync(join(root, 'modules', module, 'migrations'), { recursive: true });
    for (const name of names) writeFileSync(join(root, 'modules', module, 'migrations', name), '');
  }
  return root;
}

afterEach(() => vi.useRealTimers());

const at = (iso: string) => vi.useFakeTimers({ now: new Date(iso) });

describe('nextMigrationStamp', () => {
  it('is the stamp of now for an app without migrations', () => {
    at('2026-11-23T10:00:00.500Z');
    expect(nextMigrationStamp(app())).toBe('2026_11_23_100000');
    expect(nextMigrationStamp(app({ billing: [] }))).toBe('2026_11_23_100000');
  });

  it('sorts one second behind a future migration of another module', () => {
    at('2026-11-23T10:00:00Z');
    const root = app({ billing: ['2027_06_01_120000_create_invoices_table.ts'], sales: ['2026_01_01_000000_create_orders_table.ts'] });
    expect(nextMigrationStamp(root)).toBe('2027_06_01_120001');
  });

  it('is two seconds behind two in one second when the caller asks again after the write', () => {
    at('2026-11-23T10:00:00Z');
    const root = app({ billing: ['2027_06_01_120000_create_invoices_table.ts'] });
    const first = nextMigrationStamp(root);
    writeFileSync(join(root, 'modules/billing/migrations', `${first}_create_lines_table.ts`), '');
    expect(first).toBe('2027_06_01_120001');
    expect(nextMigrationStamp(root)).toBe('2027_06_01_120002');
  });

  it('uses now when every migration is in the past, even one whose stamp is no date', () => {
    at('2026-11-23T10:00:00Z');
    expect(nextMigrationStamp(app({ billing: ['2026_10_01_120000_create_invoices_table.ts'] }))).toBe('2026_11_23_100000');
    expect(nextMigrationStamp(app({ billing: ['2025_13_45_990000_create_invoices_table.ts'] }))).toBe('2026_11_23_100000');
  });

  it('ignores what the migrator does not read: .md, .test.ts and .d.ts', () => {
    at('2026-11-23T10:00:00Z');
    const root = app({ billing: ['2099_01_01_000000_create_invoices_table.md', '2099_01_01_000000_create_invoices_table.test.ts', '2099_01_01_000000_create_invoices_table.d.ts', 'README.md'] });
    expect(nextMigrationStamp(root)).toBe('2026_11_23_100000');
  });

  it('sorts one second behind a migration of the current second, and ignores a module without a migrations folder', () => {
    at('2026-11-23T10:00:00Z');
    const root = app({ billing: ['2026_11_23_100000_create_invoices_table.ts'] });
    mkdirSync(join(root, 'modules/bare'), { recursive: true });
    expect(nextMigrationStamp(root)).toBe('2026_11_23_100001');
  });

  it('skips a migrations entry that is a file', () => {
    at('2026-11-23T10:00:00Z');
    const root = app({ billing: ['2027_06_01_120000_create_invoices_table.ts'] });
    mkdirSync(join(root, 'modules/notes-draft'), { recursive: true });
    writeFileSync(join(root, 'modules/notes-draft/migrations'), '');
    expect(nextMigrationStamp(root)).toBe('2027_06_01_120001');
  });

  it.skipIf(process.getuid?.() === 0)('skips a module whose folder cannot be read, as publish did', () => {
    at('2026-11-23T10:00:00Z');
    const root = app({ billing: ['2027_06_01_120000_create_invoices_table.ts'] });
    mkdirSync(join(root, 'modules/notes-draft/migrations'), { recursive: true });
    chmodSync(join(root, 'modules/notes-draft'), 0o000);
    onTestFinished(() => chmodSync(join(root, 'modules/notes-draft'), 0o755));
    expect(nextMigrationStamp(root)).toBe('2027_06_01_120001');
  });

  it('refuses a future stamp that is no date, naming the file', () => {
    at('2026-11-23T10:00:00Z');
    const root = app({ billing: ['2027_13_01_120000_create_invoices_table.ts'] });
    expect(() => nextMigrationStamp(root)).toThrow(/^modules.billing.migrations.2027_13_01_120000_create_invoices_table\.ts has a timestamp that is no date, so a new migration cannot be put behind it — rename it with a valid one\.$/);
  });

  it('refuses a stamp that leaves no room', () => {
    at('2026-11-23T10:00:00Z');
    const root = app({ billing: ['9999_12_31_235959_create_invoices_table.ts'] });
    expect(() => nextMigrationStamp(root)).toThrow('has a timestamp that leaves no room behind it — rename it with an earlier one.');
  });
});

describe('newestMigration', () => {
  it('is undefined without a modules folder', () => {
    expect(newestMigration(join(tempDir('marmeon-stamps-'), 'modules'))).toBeUndefined();
  });

  it('finds the newest of all modules', () => {
    const root = app({ a: ['2026_01_01_000000_one.ts'], b: ['2026_02_01_000000_two.mjs', '2026_01_02_000000_three.js'] });
    expect(newestMigration(join(root, 'modules'))).toEqual({ stamp: '2026_02_01_000000', path: join(root, 'modules/b/migrations/2026_02_01_000000_two.mjs') });
  });
});

describe('stampsBehind', () => {
  it('counts a second apart and names the subject in its refusal', () => {
    const newest = { stamp: '2099_01_01_000000', path: '/app/modules/a/migrations/2099_01_01_000000_one.ts' };
    const result = stampsBehind(newest, 3, '/app', 'a copy', Date.UTC(2026, 10, 23));
    expect(result).toEqual({ stamps: [0, 1, 2].map((second) => new Date(Date.UTC(2099, 0, 1, 0, 0, 1 + second))) });
    expect(stampsBehind({ ...newest, stamp: '2099_00_01_000000' }, 1, '/app', 'a copy', Date.UTC(2026, 10, 23))).toEqual({
      error: 'modules/a/migrations/2099_01_01_000000_one.ts has a timestamp that is no date, so a copy cannot be put behind it — rename it with a valid one.',
    });
  });
});
