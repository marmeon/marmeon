import { marmeon } from '@marmeon/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    marmeon({
      // What the first screen sets: sans headings and text, mono 400 and 500. Italics, 600 and other subsets load on use.
      fonts: [
        { file: '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2' },
        { file: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2' },
        { file: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2' },
      ],
    }),
    react(),
  ],
});
