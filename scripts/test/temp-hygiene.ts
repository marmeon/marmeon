/**
 * Vitest global setup of the repository (`vitest.config.ts`): every run gets a temporary directory of its own — `TMPDIR` points
 * into it for the workers and every process a test starts — and at the end the run fails when a test left a `marmeon-*` entry in
 * it, with the list. Then the directory goes, whatever it holds. (Per run, not a count of `os.tmpdir()` before and after: other
 * processes write there at the same time.)
 *
 * A run killed before its teardown leaves `marmeon-run-<pid>-…`: the next run removes it once that process is gone.
 *
 * Kept until the end on purpose: only the bundle measurements' workspace (`marmeon-bundle-<checkout>`,
 * `packages/react/src/__fixtures__/bundle.ts`). The worker databases of `createTestApp` live in the app's `storage/`: a
 * `marmeon-test-*.sqlite` file here is a leftover. CONTRIBUTING.md, "The test suites against real services".
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What a run keeps until its end on purpose (see above). */
export const RUN_SCOPED = [/^marmeon-bundle-[0-9a-f]{12}$/];

/** The `marmeon-*` entries a run left in its directory, without the run-scoped ones. */
export function leftovers(entries: readonly string[]): string[] {
  return entries.filter((name) => name.startsWith('marmeon-') && !RUN_SCOPED.some((pattern) => pattern.test(name))).sort();
}

/** Whether the process `pid` still runs (a signal 0 reaches it, or it is someone else's). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The directories of runs that never reached their teardown (killed, crashed): named after their process, removed once it is gone. A
 * directory whose process still runs — another `pnpm test` right now — is left alone.
 */
export function abandonedRuns(entries: readonly string[], isAlive = alive): string[] {
  return entries.filter((name) => {
    const pid = /^marmeon-run-(\d+)-/.exec(name)?.[1];
    return pid !== undefined && !isAlive(Number(pid));
  });
}

export function setup(): () => void {
  const before = process.env.TMPDIR;
  const base = tmpdir();
  for (const name of abandonedRuns(readdirSync(base))) rmSync(join(base, name), { recursive: true, force: true, maxRetries: 3 });
  const run = mkdtempSync(join(base, `marmeon-run-${process.pid}-`));
  process.env.TMPDIR = run;
  return () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    let left: string[];
    try {
      left = leftovers(readdirSync(run));
    } finally {
      rmSync(run, { recursive: true, force: true, maxRetries: 3 });
    }
    if (left.length > 0) {
      throw new Error(
        `The tests left ${left.length} temporary entr${left.length === 1 ? 'y' : 'ies'} behind (removed now, with the run's directory) — ` +
          'a test that makes one removes it (tempDir() from scripts/test/temp-dir.js, or rmSync in afterAll/finally):\n  ' +
          left.join('\n  '),
      );
    }
  };
}
