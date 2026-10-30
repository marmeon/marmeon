import { readFileSync } from 'node:fs';
import type { HtmlTagDescriptor, Logger, Plugin } from 'vite';
import { readFontMetrics, type FontMetrics } from './font-metrics.ts';

/** The local fonts a font can borrow its metrics from while it loads: the ones nearly every system has. */
export type FontFallback = 'Arial' | 'Helvetica' | 'Times New Roman' | 'Georgia' | 'Courier New';

/** A font file the app names. See docs/vite.md#fonts. */
export interface MarmeonFont {
  /**
   * The `.woff2` file as a package-relative path, such as
   * `@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2`. A stylesheet must load it, so that the
   * build emits it; the built `index.html` then preloads it under its hashed URL.
   */
  file: string;
  /**
   * The name the stylesheet gives the font in `font-family`, such as `IBM Plex Sans Variable`. With `fallback`, the plugin adds
   * a font `<family> Fallback` to `virtual:marmeon/fonts.css`. Letters, digits, spaces and `-` only.
   */
  family?: string;
  /** The local font whose shape the fallback takes: set it apart from the web font in `font-family`, after `family`. */
  fallback?: FontFallback;
}

/**
 * The metrics of the fallbacks, read from the tables of each system font (`head`, `hhea`, `OS/2`): the average width is
 * `xAvgCharWidth`, the others are the `hhea` values. A fixed list, so that no name from the config reaches `local()`.
 */
const FALLBACKS: Readonly<Record<FontFallback, FontMetrics>> = {
  Arial: { unitsPerEm: 2048, ascender: 1854, descender: -434, lineGap: 67, xAvgCharWidth: 904 },
  Helvetica: { unitsPerEm: 2048, ascender: 1577, descender: -471, lineGap: 0, xAvgCharWidth: 904 },
  'Times New Roman': { unitsPerEm: 2048, ascender: 1825, descender: -443, lineGap: 87, xAvgCharWidth: 821 },
  Georgia: { unitsPerEm: 2048, ascender: 1878, descender: -449, lineGap: 0, xAvgCharWidth: 901 },
  'Courier New': { unitsPerEm: 2048, ascender: 1705, descender: -615, lineGap: 0, xAvgCharWidth: 1229 },
};

/** A font family name lands in CSS, so it is plain words: no quote, semicolon, brace or backslash can end the string. */
const FAMILY = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,63}$/u;

/** More preloads than this delay the first paint more than the missing swap costs. */
const PRELOAD_LIMIT = 4;

/** A `fonts` entry that is not a `.woff2` file path stops the config, before any build starts. */
export function checkFonts(fonts: readonly MarmeonFont[]): void {
  const families = new Set<string>();
  for (const font of fonts) {
    const file = (font as { file?: unknown } | null)?.file;
    if (typeof file !== 'string' || !file.toLowerCase().endsWith('.woff2')) {
      throw new TypeError(`marmeon(): \`fonts\` takes .woff2 files, got ${JSON.stringify(file)}. Convert the font, or leave it out of \`fonts\` (docs/vite.md#fonts).`);
    }
    const { family, fallback } = font as { family?: unknown; fallback?: unknown };
    if ((family === undefined) !== (fallback === undefined)) {
      throw new TypeError(`marmeon(): the font ${file} needs both \`family\` and \`fallback\`, or neither (docs/vite.md#fonts).`);
    }
    if (family !== undefined && (typeof family !== 'string' || !FAMILY.test(family))) {
      throw new TypeError(`marmeon(): the \`family\` ${JSON.stringify(family)} of ${file} may hold only letters, digits, spaces and \`-\`, up to 64 characters (docs/vite.md#fonts).`);
    }
    if (typeof family === 'string') {
      if (families.has(family)) throw new TypeError(`marmeon(): two \`fonts\` entries have the \`family\` ${JSON.stringify(family)}; give each a name of its own (docs/vite.md#fonts).`);
      families.add(family);
    }
    if (fallback !== undefined && (typeof fallback !== 'string' || !Object.hasOwn(FALLBACKS, fallback))) {
      throw new TypeError(`marmeon(): the \`fallback\` ${JSON.stringify(fallback)} of ${file} is not one of ${Object.keys(FALLBACKS).join(', ')} (docs/vite.md#fonts).`);
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

/** A share of the em as a percentage with at most four decimals: `105.1234%`. */
function percent(ratio: number): string {
  return `${Number((ratio * 100).toFixed(4))}%`;
}

/** The `@font-face` of a fallback that takes the room of `font`: scaled to its average width, with its line box. */
export function fallbackFace(family: string, fallback: FontFallback, font: FontMetrics): string {
  const system = FALLBACKS[fallback];
  const sizeAdjust = font.xAvgCharWidth / font.unitsPerEm / (system.xAvgCharWidth / system.unitsPerEm);
  const override = (value: number): string => percent(Math.abs(value) / font.unitsPerEm / sizeAdjust);
  return [
    '@font-face {',
    `  font-family: '${family} Fallback';`,
    `  src: local('${fallback}');`,
    `  size-adjust: ${percent(sizeAdjust)};`,
    `  ascent-override: ${override(font.ascender)};`,
    `  descent-override: ${override(font.descender)};`,
    `  line-gap-override: ${override(font.lineGap)};`,
    '}',
    '',
  ].join('\n');
}

const FONTS_CSS = 'virtual:marmeon/fonts.css';

/**
 * `virtual:marmeon/fonts.css`: a fallback font for each entry with `family` and `fallback`, sized from the metrics of its file
 * so that the text barely moves when the web font arrives. Ordinary CSS to Vite, so it is bundled with the app's stylesheets in
 * a build and served in development.
 */
export function fontFallbacks(fonts: readonly MarmeonFont[]): Plugin {
  const resolved = `\0${FONTS_CSS}`;
  return {
    name: 'marmeon:font-fallbacks',
    resolveId: (source) => (source === FONTS_CSS ? resolved : undefined),
    async load(id) {
      // A stylesheet linked in development is requested as `?direct`.
      if (id.split('?')[0] !== resolved) return undefined;
      const faces = new Map<string, string>();
      for (const { file, family, fallback } of fonts) {
        if (!family || !fallback || faces.has(family)) continue;
        const found = await this.resolve(file);
        if (!found) throw new Error(`marmeon(): the font ${file} in \`fonts\` cannot be resolved. Install its package, or correct the name (docs/vite.md#fonts).`);
        const path = found.id.split('?')[0]!;
        this.addWatchFile(path);
        let metrics: FontMetrics;
        try {
          metrics = readFontMetrics(readFileSync(path));
        } catch (error) {
          throw new Error(`marmeon(): cannot read the metrics of the font ${file}: ${error instanceof Error ? error.message : String(error)}. Leave \`family\` and \`fallback\` out for it (docs/vite.md#fonts).`);
        }
        faces.set(family, fallbackFace(family, fallback, metrics));
      }
      return [...faces.values()].join('\n');
    },
  };
}
