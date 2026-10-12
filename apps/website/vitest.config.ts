import { marmeon } from '@marmeon/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [marmeon({ test: true })],
  test: { include: ['modules/**/*.test.{ts,tsx}', 'build/**/*.test.ts'] },
});
