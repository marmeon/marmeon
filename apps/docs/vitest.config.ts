import { bespoke } from '@bespokecore/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [bespoke({ test: true })],
  test: { include: ['modules/**/*.test.ts'] },
});
