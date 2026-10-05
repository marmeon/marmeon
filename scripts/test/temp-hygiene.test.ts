import { describe, expect, it } from 'vitest';
import { abandonedRuns, leftovers } from './temp-hygiene.ts';

describe("the test run's temporary directory (E187)", () => {
  it('names every bespoke-* entry a test left — but not the run-scoped worker databases and bundle workspace', () => {
    const entries = [
      'bespoke-env-x9laHo',
      'bespoke-schedule-GdChsL',
      'bespoke-test-6ns6v3-1.sqlite',
      'bespoke-test-6ns6v3-1.sqlite-wal',
      'bespoke-test-6ns6v3-1.sqlite-shm',
      'bespoke-bundle-7f694eea9c2f',
      'bespoke-test-6ns6v3-1.sqlite.backup',
      'vite-cache',
    ];
    expect(leftovers(entries)).toEqual(['bespoke-env-x9laHo', 'bespoke-schedule-GdChsL', 'bespoke-test-6ns6v3-1.sqlite.backup']);
  });

  it('runs this test in a directory of its own (TMPDIR), named after the run’s process, inside which every entry is the run’s', async () => {
    const { tmpdir } = await import('node:os');
    expect(tmpdir()).toMatch(/bespoke-run-\d+-[^/]+\/?$/);
  });

  it('removes the directory of a run that was killed before its teardown — once its process is gone, never a running one', () => {
    const running = new Set([101]);
    const entries = ['bespoke-run-101-AbCdEf', 'bespoke-run-202-GhIjKl', 'bespoke-run-XyZ', 'bespoke-bench', 'bespoke-env-202-x'];
    expect(abandonedRuns(entries, (pid) => running.has(pid))).toEqual(['bespoke-run-202-GhIjKl']);
  });
});
