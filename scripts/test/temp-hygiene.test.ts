import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { abandonedRuns, leftovers, start } from './temp-hygiene.ts';
import { tempDir } from './temp-dir.js';

describe("the test run's temporary directory", () => {
  it('names every marmeon-* entry a test left — but not the run-scoped bundle workspace', () => {
    const entries = [
      'marmeon-env-x9laHo',
      'marmeon-schedule-GdChsL',
      'marmeon-bundle-7f694eea9c2f',
      'marmeon-test-6ns6v3-1.sqlite.backup',
      'vite-cache',
    ];
    expect(leftovers(entries)).toEqual(['marmeon-env-x9laHo', 'marmeon-schedule-GdChsL', 'marmeon-test-6ns6v3-1.sqlite.backup']);
  });

  it('names a worker database in the run’s directory: it belongs in the app’s storage/framework/testing', () => {
    expect(leftovers(['marmeon-test-x-1.sqlite', 'marmeon-test-x-1.sqlite-wal'])).toEqual(['marmeon-test-x-1.sqlite', 'marmeon-test-x-1.sqlite-wal']);
  });

  it('runs this test in a directory of its own (TMPDIR), named after the run’s process, inside which every entry is the run’s', async () => {
    const { tmpdir } = await import('node:os');
    expect(tmpdir()).toMatch(/marmeon-run-\d+-[^/]+\/?$/);
  });

  it('removes the directory of a run that was killed before its teardown — once its process is gone, never a running one', () => {
    const running = new Set([101]);
    const entries = ['marmeon-run-101-AbCdEf', 'marmeon-run-202-GhIjKl', 'marmeon-run-XyZ', 'marmeon-bench', 'marmeon-env-202-x'];
    expect(abandonedRuns(entries, (pid) => running.has(pid))).toEqual(['marmeon-run-202-GhIjKl']);
  });

  it('gives the run a second directory in the checkout (.tmp), named after the process, for the roots that need the workspace', () => {
    expect(process.env.MARMEON_WORKSPACE_TMPDIR).toMatch(/\/\.tmp\/marmeon-run-\d+-[^/]+$/);
    expect(abandonedRuns(['marmeon-run-303-x'], () => false)).toEqual(['marmeon-run-303-x']);
  });

  it('reports what a test left in the workspace directory as .tmp/<name>, and removes it', () => {
    const base = tempDir('marmeon-hygiene-');
    const workspaceBase = join(base, '.tmp');
    const outer = { tmp: process.env.TMPDIR, workspace: process.env.MARMEON_WORKSPACE_TMPDIR };
    const teardown = start(base, workspaceBase);
    const run = process.env.MARMEON_WORKSPACE_TMPDIR!;
    try {
      expect(run.startsWith(`${workspaceBase}/`)).toBe(true);
      writeFileSync(join(run, 'marmeon-x'), '');
      expect(() => teardown()).toThrow(/\.tmp\/marmeon-x/);
      expect(existsSync(run)).toBe(false);
      expect(readdirSync(workspaceBase)).toEqual([]);
    } finally {
      if (outer.tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = outer.tmp;
      process.env.MARMEON_WORKSPACE_TMPDIR = outer.workspace;
    }
  });
});
