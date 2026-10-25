import type { HtmlTagDescriptor, Logger, Plugin } from 'vite';

/** A font file the app names. See docs/vite.md#fonts. */
export interface MarmeonFont {
  /**
   * The `.woff2` file as a package-relative path, such as
   * `@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2`. A stylesheet must load it, so that the
   * build emits it; the built `index.html` then preloads it under its hashed URL.
   */
  file: string;
}

/** More preloads than this delay the first paint more than the missing swap costs. */
const PRELOAD_LIMIT = 4;

/** A `fonts` entry that is not a `.woff2` file path stops the config, before any build starts. */
export function checkFonts(fonts: readonly MarmeonFont[]): void {
  for (const font of fonts) {
    const file = (font as { file?: unknown } | null)?.file;
    if (typeof file !== 'string' || !file.toLowerCase().endsWith('.woff2')) {
      throw new TypeError(`marmeon(): \`fonts\` takes .woff2 files, got ${JSON.stringify(file)}. Convert the font, or leave it out of \`fonts\` (docs/vite.md#fonts).`);
    }
    if (file.startsWith('/') || file.includes('\\') || /^[a-z]:/i.test(file) || file.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      throw new TypeError(`marmeon(): \`fonts\` file ${JSON.stringify(file)} must be a package-relative path such as \`@fontsource/…/files/….woff2\` (docs/vite.md#fonts).`);
    }
  }
}

/**
 * Preloads the named fonts from the built `index.html`. The URL comes from the emitted asset, never from the option; a file the
 * build did not emit stops the build instead of silently dropping its preload.
 */
export function preloadFonts(fonts: readonly MarmeonFont[]): Plugin {
  let base = '/';
  let logger: Logger | undefined;
  const files = [...new Set(fonts.map(({ file }) => file))];
  const isNamed = (id: string): boolean => {
    const path = id.replaceAll('\\', '/').split('?')[0] ?? '';
    return files.some((file) => path === file || path.endsWith(`/${file}`));
  };
  return {
    name: 'marmeon:preload-fonts',
    apply: 'build',
    // A font below `assetsInlineLimit` would become a data URI, and there is no file to preload: a named font is always emitted.
    // The app's own setting still applies to everything else.
    config(config) {
      const own = config.build?.assetsInlineLimit;
      return {
        build: {
          assetsInlineLimit: (file: string, content: Buffer) => {
            if (isNamed(file)) return false;
            if (typeof own === 'function') return own(file, content);
            return typeof own === 'number' ? content.length < own : undefined;
          },
        },
      };
    },
    configResolved(resolved) {
      base = resolved.base.endsWith('/') ? resolved.base : `${resolved.base}/`;
      logger = resolved.logger;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle }): HtmlTagDescriptor[] {
        // Here, not in `configResolved`: a build resolves the config several times, and only the client build has a document.
        if (files.length > PRELOAD_LIMIT) {
          logger?.warn(`marmeon(): \`fonts\` names ${files.length} files and every one is preloaded. More than ${PRELOAD_LIMIT} delay the first paint; name only what the first screen sets (docs/vite.md#fonts).`);
        }
        const assets = Object.values(bundle ?? {}).filter((chunk) => chunk.type === 'asset');
        return files.map((file) => {
          const asset = assets.find((candidate) =>
            candidate.originalFileNames.some((name) => {
              const path = name.replaceAll('\\', '/');
              return path === file || path.endsWith(`/${file}`);
            }),
          );
          if (!asset) {
            throw new Error(`marmeon(): the font ${file} is not in the build. Load it from a stylesheet (an \`@import\` or an \`@font-face\` \`url()\`), or correct the name in \`fonts\` (docs/vite.md#fonts).`);
          }
          return {
            tag: 'link',
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `${base}${asset.fileName}`, crossorigin: true },
            injectTo: 'head',
          };
        });
      },
    },
  };
}
