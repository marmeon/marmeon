import { bespoke } from '@bespokecore/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Workspace sources instead of built `dist/` output, and constructor injection for code Vitest loads
  // (the Node hook does not see it).
  plugins: [bespoke({ test: true })],
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'apps/*/modules/**/*.test.ts'],
  },
});
