import { marmeon } from '@marmeon/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // The first screen sets IBM Plex Sans (styles/app.css), so its Latin subset is preloaded; the other subsets load on use.
    marmeon({ fonts: [{ file: '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2' }] }),
    react(),
  ],
});
