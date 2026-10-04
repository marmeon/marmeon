import { bespoke } from '@bespokecore/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Workspace sources instead of built `dist/` output, and constructor injection for code Vitest loads
  // (the Node hook does not see it).
  plugins: [bespoke({ test: true })],
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'apps/*/modules/**/*.test.ts'],
    // With Postgres: drops the test databases the run left behind (only `<database>_test_*` on BESPOKE_TEST_PGSQL_URL's server).
    globalSetup: ['packages/database/src/__fixtures__/test-databases.ts'],
  },
});
