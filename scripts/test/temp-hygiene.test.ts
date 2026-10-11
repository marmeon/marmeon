import { describe, expect, it } from 'vitest';
import { abandonedRuns, leftovers } from './temp-hygiene.ts';

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
});
