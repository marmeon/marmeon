import { bespokeInjection } from '@bespokecore/core/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defaultServerConditions, defineConfig } from 'vite';

// Resolve workspace packages to their TypeScript sources (see "exports" in packages/*/package.json).
const source = '@bespokecore/source';

export default defineConfig({
  plugins: [bespokeInjection(), react()],
  resolve: {
    conditions: [source, ...defaultClientConditions],
    dedupe: ['react', 'react-dom'],
  },
  ssr: { resolve: { conditions: [source, ...defaultServerConditions] } },
  build: { emptyOutDir: true },
});
