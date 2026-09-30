import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests run against workspace sources, not built `dist/` output.
  ssr: { resolve: { conditions: ['@bespokecore/source', ...defaultServerConditions] } },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/modules/**/*.test.ts'],
  },
});
