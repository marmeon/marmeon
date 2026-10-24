import { globSync } from 'node:fs';
import { marmeon } from '@marmeon/vite';
import { defineConfig } from 'vitest/config';
import { groupByServices, serviceFiles, splitTiming, timingEnv, tripwireEnv } from './scripts/test/services.ts';

const include = ['packages/*/src/**/*.test.{ts,tsx}', 'apps/*/modules/**/*.test.{ts,tsx}', 'apps/*/build/**/*.test.ts', 'scripts/**/*.test.ts'];
const root = import.meta.dirname;
const found = globSync(include, { cwd: root, exclude: (name) => name === 'node_modules' || name === 'dist' || name.startsWith('.') }).sort();
const { timing: timingFiles, other: candidates } = splitTiming(found);

// One project per set of services the tests need, derived from the source (scripts/test/services.ts). `pnpm test:pgsql`,
// `test:redis` and `test:s3` run the projects that include their service; `pnpm test` runs all of them.
//
// Every project gets tripwire values for the services it was not selected for: a test the derivation missed turns the plain
// `pnpm test` red with a host name ending in `.invalid` (RFC 6761: never resolves, so no connection to a service is opened), where it would otherwise lose
// its Postgres, Redis or S3 coverage without anyone noticing.
const projects = [...groupByServices(serviceFiles(root, candidates))].map(([name, { services, files }]) => ({
  extends: true as const,
  test: {
    name,
    include: files,
    env: tripwireEnv(services),
    // The root's global setup runs once per run, not once per project.
    globalSetup: [],
  },
}));

// The tests that assert something about wall-clock time (`*.timing.test.ts`) run last and alone: a ratio or a bound holds on a
// machine that does nothing else. They need no service, so they run on SQLite and in memory with the tripwires of all three.
// Vitest wants a `groupOrder` of its own for a project with other worker limits; the others stay at 0.
const timing = {
  extends: true as const,
  test: { name: 'timing', include: timingFiles, env: timingEnv(), globalSetup: [], maxWorkers: 1, sequence: { groupOrder: 2 } },
};

export default defineConfig({
  // Workspace sources instead of built `dist/` output, and constructor injection for code Vitest loads
  // (the Node hook does not see it).
  plugins: [marmeon({ test: true })],
  test: {
    // Console output of passing tests (the default logger prints every query) stays out of the CI log; a failing test still shows its own.
    silent: 'passed-only',
    // A temporary directory per run (TMPDIR for every worker and process), and a red run when a test leaves a `marmeon-*` entry in it.
    // With Postgres: drops the test databases the run left behind (only this checkout's `<database>_test_<tag>_*` ones on MARMEON_TEST_PGSQL_URL's server; another checkout's run keeps its own).
    globalSetup: ['scripts/test/temp-hygiene.ts', 'packages/database/src/__fixtures__/test-databases.ts'],
    projects: [...projects, timing],
  },
});
