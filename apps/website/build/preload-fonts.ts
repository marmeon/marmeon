import type { HtmlTagDescriptor, Plugin } from 'vite';

/**
 * Preloads the given font files from the built `index.html` under their hashed URLs. `files` are
 * package-relative paths such as `@fontsource/ibm-plex-mono/files/….woff2`; a file the build did not
 * emit fails the build instead of silently dropping its preload.
 */
export function preloadFonts(files: readonly string[]): Plugin {
  return {
    name: 'website:preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle }): HtmlTagDescriptor[] {
        const assets = Object.values(bundle ?? {}).filter((chunk) => chunk.type === 'asset');
        return files.map((file) => {
          const asset = assets.find((candidate) =>
            candidate.originalFileNames.some((name) => name.replaceAll('\\', '/').endsWith(`/${file}`)),
          );
          if (!asset) {
            throw new Error(`preloadFonts: ${file} is not in the build — was the font renamed or its import dropped?`);
          }
          return {
            tag: 'link',
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${asset.fileName}`, crossorigin: true },
            injectTo: 'head',
          };
        });
      },
    },
  };
}
