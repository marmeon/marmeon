import { marmeon } from '@marmeon/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { preloadFonts } from './build/preload-fonts.ts';

export default defineConfig({
  plugins: [
    marmeon(),
    react(),
    // What the first screen sets: serif headings and text, mono 400 and 500. Italics, 600 and other subsets load on use.
    preloadFonts([
      '@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2',
      '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
      '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2',
    ]),
  ],
});
