import { marmeon } from '@marmeon/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // The first screen sets IBM Plex Sans (styles/app.css), so its Latin subset is preloaded, and Arial stands in, sized to match,
    // until it arrives (bootstrap/client.tsx imports the stand-in). The other subsets load on use.
    marmeon({ fonts: [{ file: '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2', family: 'IBM Plex Sans Variable', fallback: 'Arial' }] }),
    react(),
  ],
});
