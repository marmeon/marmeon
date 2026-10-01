import { bespokeInjection } from '@bespokecore/core/vite';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [bespokeInjection()],
  ssr: { resolve: { conditions: ['@bespokecore/source', ...defaultServerConditions] } },
  test: { include: ['modules/**/*.test.ts'] },
});
