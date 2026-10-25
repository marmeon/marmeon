import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFileLoadingAllowed, normalizePath, type Plugin, type ResolvedConfig } from 'vite';

/** How `import hero from './hero.jpg?image'` builds its variants. See docs/images.md#images-of-the-app. */
export interface ImageOptions {
  /** The widths to build, in pixels. Default `[640, 960, 1280, 1920, 2560]`; a width above the original's is dropped. */
  widths?: readonly number[];
  /** The newer formats to build next to the original's. Default `['avif', 'webp']`. */
  formats?: readonly ImageFormat[];
  /** Quality of the lossy formats, 1 to 100. Default 70. */
  quality?: number;
}

export type ImageFormat = 'avif' | 'webp';

/** Seams for the tests: a small pixel limit, the module name standing for `sharp`, a count of the encodes. */
export interface ImagesInternals {
  limitInputPixels?: number;
  sharpModule?: string;
  onEncode?: (file: string, width: number, format: string) => void;
}

/** The most pixels one image may have: a larger file is a decompression bomb, not a picture. */
const MAX_INPUT_PIXELS = 50_000_000;
const DEFAULT_WIDTHS = [640, 960, 1280, 1920, 2560];
const DEFAULT_FORMATS: readonly ImageFormat[] = ['avif', 'webp'];
const DEFAULT_QUALITY = 70;
const MAX_WIDTH = 8192;
const QUERY = '?image';
/** Names the fixed encoder settings (PNG compression level …): another value here is another cache key and URL. */
const ENCODER_SETTINGS = 'png9';
const SNIFF_LENGTH = 64;
const INPUT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };

type Sharp = (typeof import('sharp'))['default'];
interface Variant {
  width: number;
  format: string;
  fileName: string;
}

/** The module `import x from './file.jpg?image'` resolves to: an `ImageSource`, built with `sharp` (loaded only for such an import). */
export function images(options: ImageOptions = {}, internals: ImagesInternals = {}): Plugin {
  const widths = validWidths(options.widths ?? DEFAULT_WIDTHS);
  const formats = validFormats(options.formats ?? DEFAULT_FORMATS);
  const quality = options.quality ?? DEFAULT_QUALITY;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new TypeError('marmeon({ images }): `quality` is a whole number from 1 to 100.');
  const limitInputPixels = internals.limitInputPixels ?? MAX_INPUT_PIXELS;

  let config: ResolvedConfig;
  let root = process.cwd();
  let sharp: Promise<Sharp> | undefined;

  const load = (): Promise<Sharp> => {
    sharp ??= loadSharp(root, internals.sharpModule ?? 'sharp');
    // A refusal is not kept: the next import tries again (an app may install sharp while the dev server runs).
    sharp.catch(() => (sharp = undefined));
    return sharp;
  };

  return {
    name: 'marmeon:images',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
      root = resolved.root;
    },
    async resolveId(source, importer, resolveOptions) {
      if (!source.endsWith(QUERY)) return undefined;
      const resolved = await this.resolve(source.slice(0, -QUERY.length), importer, { ...resolveOptions, skipSelf: true });
      if (!resolved || resolved.external) this.error(`images: cannot find \`${source}\`${importer ? ` imported by ${shorten(root, importer)}` : ''}.`);
      return `${resolved.id.replace(/[?#].*$/, '')}${QUERY}`;
    },
    async load(id) {
      if (!id.endsWith(QUERY)) return undefined;
      const file = id.slice(0, -QUERY.length);
      const name = shorten(root, file);
      this.addWatchFile(file);
      const real = existsSync(file) && statSync(file).isFile() ? realpathSync(file) : undefined;
      if (!real) this.error(`images: ${name} does not exist.`);
      if (!INPUT_EXTENSIONS.has(extname(real).toLowerCase())) {
        const hint = /\.(svg|gif)$/i.test(real) ? ' SVG and GIF are not processed: import it without `?image`.' : '';
        this.error(`images: ${name} is not a .jpg, .jpeg, .png, .webp or .avif file.${hint}`);
      }
      // Only the app's own files, and only those Vite's `server.fs` rules let through: no `../../etc`, no `fs.deny`.
      if (!inside(realpathSync(root), real) || !isFileLoadingAllowed(config, normalizePath(real))) {
        this.error(`images: ${name} is outside the app or denied by \`server.fs\`; \`?image\` reads only the app's own files.`);
      }

      if (!/^(\/|https?:\/\/)/.test(config.base)) {
        this.error(`images: \`?image\` needs an absolute \`base\` ('/' or a URL), not '${config.base}': the URLs of the variants are written into the code.`);
      }
      // Magic bytes first: sharp is not even loaded for a file that is no JPEG, PNG, WebP or AVIF (an SVG under a raster name would
      // reach its XML parser).
      const kind = await sniffRaster(real);
      if (!kind) {
        const hint = (await markupHint(real)) ? ' SVG and GIF are not processed: import it without `?image`.' : '';
        this.error(`images: ${name} is not a JPEG, PNG, WebP or AVIF picture.${hint}`);
      }
      const library = await load().catch((error: unknown) => this.error(errorMessage(error)));
      const meta = await inspect(library, real, name, limitInputPixels).catch((error: unknown) => this.error(errorMessage(error)));

      if (config.command !== 'build') {
        // Development resizes nothing: the original, with its size.
        const src = `${config.base}${normalizePath(relative(realpathSync(root), real))}`;
        return moduleCode({ src, width: meta.width, height: meta.height });
      }

      const bytes = await readFile(real);
      const own = meta.format;
      const useWidths = widths.filter((width) => width <= meta.width);
      const chosen = useWidths.length > 0 ? useWidths : [meta.width];
      const stem = basename(real, extname(real)).replace(/[^A-Za-z0-9_-]/g, '-');
      // The encoders' versions are part of the key: another libvips writes other bytes.
      const versions = JSON.stringify(library.versions);
      const key = (width: number, format: string) =>
        createHash('sha256').update(bytes).update(`\0${quality}\0${width}\0${format}\0${ENCODER_SETTINGS}\0${versions}`).digest('hex');
      const variantsOf = (format: string): Variant[] =>
        chosen.map((width) => ({ width, format, fileName: `assets/${stem}-${width}w-${key(width, format).slice(0, 8)}.${format === 'jpeg' ? 'jpg' : format}` }));
      const srcset = (variants: Variant[]) => variants.map((variant) => `${config.base}${variant.fileName} ${variant.width}w`).join(', ');

      const original = variantsOf(own);
      const extra = formats.filter((format) => format !== own).map((format) => ({ format, variants: variantsOf(format) }));

      // The client build writes the files; the server build only names them, from the same inputs, so both agree.
      if (this.environment.name === 'client') {
        const cache = join(root, 'node_modules', '.cache', 'marmeon-images');
        for (const variant of [...original, ...extra.flatMap((entry) => entry.variants)]) {
          const encoded = await cached(cache, key(variant.width, variant.format), async () => {
            internals.onEncode?.(real, variant.width, variant.format);
            return library(real, { limitInputPixels })
              .rotate()
              .resize({ width: variant.width, withoutEnlargement: true })
              .toFormat(variant.format as 'jpeg', variant.format === 'png' ? { compressionLevel: 9 } : { quality })
              .toBuffer();
          }).catch((error: unknown) => this.error(`images: ${name}: ${errorMessage(error)}`));
          this.emitFile({ type: 'asset', fileName: variant.fileName, source: encoded });
        }
      }

      const largest = original[original.length - 1] as Variant;
      return moduleCode({
        src: `${config.base}${largest.fileName}`,
        width: largest.width,
        height: Math.max(1, Math.round((largest.width * meta.height) / meta.width)),
        srcset: srcset(original),
        sources: extra.map((entry) => ({ type: MIME[entry.format] as string, srcset: srcset(entry.variants) })),
      });
    },
  };
}

function moduleCode(source: object): string {
  return `export default ${JSON.stringify(source)};\n`;
}

function validWidths(widths: readonly number[]): number[] {
  if (widths.length === 0 || widths.some((width) => !Number.isInteger(width) || width < 1 || width > MAX_WIDTH)) {
    throw new TypeError(`marmeon({ images }): \`widths\` is a list of whole numbers from 1 to ${MAX_WIDTH}.`);
  }
  return [...new Set(widths)].sort((a, b) => a - b);
}

function validFormats(formats: readonly string[]): ImageFormat[] {
  if (formats.some((format) => format !== 'avif' && format !== 'webp')) throw new TypeError("marmeon({ images }): `formats` lists 'avif' and 'webp'.");
  return [...new Set(formats)] as ImageFormat[];
}

/** The app's files only: `file` is under `root` (both real paths). */
function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== '' && !path.startsWith('..') && !path.includes(`..${sep}`) && resolve(root, path) === file;
}

function shorten(root: string, file: string): string {
  const path = relative(root, file.replace(/[?#].*$/, ''));
  return path.startsWith('..') ? basename(file) : normalizePath(path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `sharp` of the app (an optional peer of this package), loaded on the first `?image` import. */
async function loadSharp(root: string, name: string): Promise<Sharp> {
  let path: string;
  try {
    path = createRequire(join(root, 'package.json')).resolve(name);
  } catch (error) {
    throw new Error('images: `?image` needs sharp: pnpm add -D sharp', { cause: error });
  }
  try {
    const module = (await import(pathToFileURL(path).href)) as { default?: Sharp };
    return module.default ?? (module as unknown as Sharp);
  } catch (error) {
    throw new Error('images: sharp is installed but did not load (see the cause; its platform package may be missing).', { cause: error });
  }
}

/** Reads the header only, and refuses what is not a raster picture or has too many pixels, before anything is decoded. */
async function inspect(sharp: Sharp, file: string, name: string, limit: number): Promise<{ width: number; height: number; format: string }> {
  // `limitInputPixels: false` reads the header without a limit of sharp's own: the check below names the file and the size.
  const meta = await sharp(file, { limitInputPixels: false })
    .metadata()
    .catch((error: unknown) => {
      throw new Error(`images: ${name}: ${errorMessage(error)}`, { cause: error });
    });
  const { format, width, height } = meta;
  const raster = format === 'jpeg' || format === 'png' || format === 'webp' || (format === 'heif' && meta.compression === 'av1');
  if (!raster || !width || !height) {
    const hint = format === 'svg' || format === 'gif' ? ' SVG and GIF are not processed: import it without `?image`.' : '';
    throw new Error(`images: ${name} is not a JPEG, PNG, WebP or AVIF picture.${hint}`);
  }
  if (width * height > limit) throw new Error(`images: ${name} has ${width}×${height} pixels, more than the ${limit.toLocaleString('en')} an image may have.`);
  // EXIF orientation 5 to 8 turns the picture on its side; `rotate()` applies it, so the size swaps.
  const turned = (meta.orientation ?? 1) >= 5;
  return { width: turned ? height : width, height: turned ? width : height, format: format === 'heif' ? 'avif' : format };
}

/** `png`, `jpeg`, `webp` or `avif` by the first bytes (as the uploads' sniffing does); anything else is `undefined`. Reads {@link SNIFF_LENGTH} bytes. */
async function sniffRaster(file: string): Promise<string | undefined> {
  const bytes = await head(file);
  const ascii = (at: number, text: string) => bytes.length >= at + text.length && [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(4, 'ftyp') && bytes.length >= 16) {
    const size = Math.min(bytes.length, ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0);
    const brands = [bytes.subarray(8, 12), ...Array.from({ length: Math.max(0, Math.floor((size - 16) / 4)) }, (_, i) => bytes.subarray(16 + i * 4, 20 + i * 4))];
    if (brands.some((brand) => ['avif', 'avis'].includes(String.fromCharCode(...brand)))) return 'avif';
  }
  return undefined;
}

/** Whether the file starts like an SVG, XML or GIF: for the hint, nothing more. */
async function markupHint(file: string): Promise<boolean> {
  const text = Buffer.from(await head(file)).toString('latin1').replace(/^\xef\xbb\xbf/, '').replace(/^\s+/, '').toLowerCase();
  return text.startsWith('<svg') || text.startsWith('<?xml') || text.startsWith('gif8');
}

async function head(file: string): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(SNIFF_LENGTH);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_LENGTH, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The bytes stored under `key` in `directory`, or what `make` returns, stored for the next build. */
async function cached(directory: string, key: string, make: () => Promise<Buffer>): Promise<Buffer> {
  const file = join(directory, key);
  try {
    return await readFile(file);
  } catch {
    // Not cached yet.
  }
  const bytes = await make();
  try {
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, file);
  } catch {
    // A cache that cannot be written only costs the next build its encodes.
  }
  return bytes;
}
