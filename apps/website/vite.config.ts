import { marmeon } from '@marmeon/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    marmeon({
      // What the first screen sets: Inter for text, Inter Tight for headlines, Instrument Serif italic for accent words, Plex Mono for
      // code and labels. Other weights, italics and subsets load on use.
      fonts: [
        { file: '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2' },
        { file: '@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2' },
        { file: '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2' },
        { file: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2' },
      ],
    }),
    react(),
  ],
});
