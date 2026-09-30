import { bespokeInjection } from '@bespokecore/core/vite';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Constructor injection for code Vitest loads (the Node hook does not see it).
  plugins: [bespokeInjection()],
  // Tests run against workspace sources, not built `dist/` output.
  ssr: { resolve: { conditions: ['@bespokecore/source', ...defaultServerConditions] } },
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'apps/*/modules/**/*.test.ts'],
  },
});
