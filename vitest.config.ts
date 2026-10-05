import { bespoke } from '@bespokecore/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Workspace sources instead of built `dist/` output, and constructor injection for code Vitest loads
  // (the Node hook does not see it).
  plugins: [bespoke({ test: true })],
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'apps/*/modules/**/*.test.ts', 'scripts/**/*.test.ts'],
    // A temporary directory per run (TMPDIR for every worker and process), and a red run when a test leaves a `bespoke-*` entry in it (E187).
    // With Postgres: drops the test databases the run left behind (only `<database>_test_*` on BESPOKE_TEST_PGSQL_URL's server).
    globalSetup: ['scripts/test/temp-hygiene.ts', 'packages/database/src/__fixtures__/test-databases.ts'],
  },
});
