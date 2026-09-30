import react from '@vitejs/plugin-react';
import { defaultClientConditions, defaultServerConditions, defineConfig } from 'vite';

const source = '@bespokecore/source';

// Consumed by @bespokecore/server once Vite runs in middleware mode for SSR.
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: [source, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [source, ...defaultServerConditions] } },
});
