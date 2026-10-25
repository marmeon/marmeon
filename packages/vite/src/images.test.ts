import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { build, createServer, type Plugin, type ViteDevServer } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { images, type ImageOptions, type ImagesInternals } from './images.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const sharpPackage = realpathSync(fileURLToPath(new URL('../node_modules/sharp', import.meta.url)));
const servers: ViteDevServer[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

interface Built {
  src: string;
  width: number;
  height: number;
  srcset?: string;
  sources?: { type: string; srcset: string }[];
}

/** A plain picture of the given size in the given format. */
function picture(width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'jpeg'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 200 } } })
    .toFormat(format)
    .toBuffer();
}

function link(root: string): void {
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(sharpPackage, join(root, 'node_modules/sharp'), 'dir');
}

/** A small app: `main.js` imports every `?image` file listed, `files` brings the pictures. */
function app(files: Record<string, string | Buffer>, { withSharp = true, entry = ['./hero.jpg?image'] }: { withSharp?: boolean; entry?: string[] } = {}): string {
  const root = realpathSync(tempDir('marmeon-images-'));
  const all: Record<string, string | Buffer> = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'main.js': `${entry.map((path, index) => `import image${index} from '${path}';`).join('\n')}\nexport const images = [${entry.map((_, index) => `image${index}`).join(', ')}];\n`,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (withSharp) link(root);
  return root;
}

interface BuildOptions {
  options?: ImageOptions;
  internals?: ImagesInternals;
  ssr?: boolean;
  extra?: Plugin[];
  fs?: { deny?: string[] };
  base?: string;
}

/** Builds `main.js` as a library (client) or an SSR bundle and returns what it exports plus the files under `assets/`. */
async function run(root: string, { options, internals, ssr = false, extra = [], fs, base }: BuildOptions = {}): Promise<{ images: Built[]; assets: string[]; out: string }> {
  const out = join(root, ssr ? 'dist/server' : 'dist/client');
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    envDir: false,
    plugins: [images(options, internals), ...extra],
    ...(fs ? { server: { fs } } : {}),
    ...(base ? { base } : {}),
    build: ssr ? { outDir: out, ssr: 'main.js', emptyOutDir: true } : { outDir: out, emptyOutDir: true, lib: { entry: 'main.js', formats: ['es'], fileName: 'main' } },
  });
  const file = readdirSync(out).find((name) => /^main\.m?js$/.test(name));
  const exported = (await import(`${pathToFileURL(join(out, file as string)).href}?${Date.now()}${Math.random()}`)) as { images: Built[] };
  let assets: string[] = [];
  try {
    assets = readdirSync(join(out, 'assets')).sort();
  } catch {
    // No `assets/` folder: nothing was written.
  }
  return { images: exported.images, assets, out };
}

function urls(srcset: string): string[] {
  return srcset.split(', ').map((entry) => entry.split(' ')[0] as string);
}

async function failure(root: string, options: BuildOptions = {}): Promise<string> {
  return run(root, options).then(
    () => 'built',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe('images', () => {
  it('builds the widths up to the original, in AVIF, WebP and the original format', async () => {
    const root = app({ 'hero.jpg': await picture(1000, 500) });
    const { images: [hero], assets, out } = await run(root);
    const image = hero as Built;
    expect(image.srcset).toMatch(/^\/assets\/hero-640w-[0-9a-f]{8}\.jpg 640w, \/assets\/hero-960w-[0-9a-f]{8}\.jpg 960w$/);
    expect(image.sources?.map((source) => source.type)).toEqual(['image/avif', 'image/webp']);
    expect(image.sources?.[0]?.srcset).toMatch(/^\/assets\/hero-640w-[0-9a-f]{8}\.avif 640w, \/assets\/hero-960w-[0-9a-f]{8}\.avif 960w$/);
    expect(image.sources?.[1]?.srcset).toMatch(/\.webp 960w$/);
    // `src` and its size are the largest variant's, the height keeps the ratio.
    expect(image.src).toBe(urls(image.srcset as string)[1]);
    expect([image.width, image.height]).toEqual([960, 480]);
    expect(assets).toHaveLength(6);
    for (const url of [...urls(image.srcset as string), ...(image.sources ?? []).flatMap((source) => urls(source.srcset))]) {
      const width = Number(/-(\d+)w-/.exec(url)?.[1]);
      expect((await sharp(join(out, url)).metadata()).width).toBe(width);
    }
  });

  it('keeps the original width when it is below every configured width', async () => {
    const root = app({ 'hero.jpg': await picture(300, 200) });
    const { images: [hero] } = await run(root);
    expect(hero?.srcset).toMatch(/^\/assets\/hero-300w-[0-9a-f]{8}\.jpg 300w$/);
    expect([hero?.width, hero?.height]).toEqual([300, 200]);
  });

  it('takes widths and formats from the options, and builds no format twice', async () => {
    const root = app({ 'hero.webp': await picture(1000, 500, 'webp') }, { entry: ['./hero.webp?image'] });
    const { images: [hero], assets } = await run(root, { options: { widths: [500, 800, 5000], formats: ['avif', 'webp'], quality: 40 } });
    expect(hero?.srcset).toMatch(/-500w-.*\.webp 500w, .*-800w-.*\.webp 800w$/);
    expect(hero?.sources?.map((source) => source.type)).toEqual(['image/avif']);
    expect(assets).toHaveLength(4);
  });

  it('keeps a PNG a PNG', async () => {
    const root = app({ 'hero.png': await picture(700, 100, 'png') }, { entry: ['./hero.png?image'] });
    const { images: [hero] } = await run(root, { options: { formats: [] } });
    expect(hero?.srcset).toMatch(/\.png 640w$/);
    expect(hero?.sources).toEqual([]);
  });

  it('gives the client and the server build the same URLs, and only the client build writes files', async () => {
    const root = app({ 'hero.jpg': await picture(1000, 500) });
    const client = await run(root);
    const server = await run(root, { ssr: true });
    expect(server.images).toEqual(client.images);
    expect(server.assets).toEqual([]);
    expect(client.assets).toHaveLength(6);
  });

  it('encodes nothing a second time', async () => {
    const root = app({ 'hero.jpg': await picture(1000, 500) });
    const encoded: string[] = [];
    const internals = { onEncode: (_file: string, width: number, format: string) => encoded.push(`${width}.${format}`) };
    const first = await run(root, { internals });
    expect(encoded).toHaveLength(6);
    const second = await run(root, { internals });
    expect(encoded).toHaveLength(6);
    expect(second.images).toEqual(first.images);
    // Another quality is another key.
    await run(root, { internals, options: { quality: 50 } });
    expect(encoded.length).toBeGreaterThan(6);
  });

  it('names a file after its content', async () => {
    const one = await run(app({ 'hero.jpg': await picture(1000, 500) }));
    const other = await run(app({ 'hero.jpg': await picture(1000, 501) }));
    expect(other.images[0]?.src).not.toBe(one.images[0]?.src);
  });

  it('serves the original with its size in development', async () => {
    const root = app({ 'hero.jpg': await picture(1000, 500), 'modules/a/pic.png': await picture(40, 20, 'png') }, { entry: ['./hero.jpg?image', './modules/a/pic.png?image'] });
    const server = await createServer({ root, configFile: false, logLevel: 'silent', appType: 'custom', envDir: false, server: { middlewareMode: true, hmr: false, ws: false }, plugins: [images()] });
    servers.push(server);
    const loaded = (await server.ssrLoadModule('/main.js')) as { images: Built[] };
    expect(loaded.images).toEqual([
      { src: '/hero.jpg', width: 1000, height: 500 },
      { src: '/modules/a/pic.png', width: 40, height: 20 },
    ]);
  });

  describe('refuses', () => {
    it('an SVG, with a hint at the plain import', async () => {
      const root = app({ 'hero.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' }, { entry: ['./hero.svg?image'] });
      expect(await failure(root)).toMatch(/hero\.svg is not a \.jpg.*import it without `\?image`/);
    });

    it('a GIF', async () => {
      const root = app({ 'hero.gif': Buffer.from('GIF89a') }, { entry: ['./hero.gif?image'] });
      expect(await failure(root)).toMatch(/hero\.gif.*import it without `\?image`/);
    });

    it('an SVG under a raster name', async () => {
      const root = app({ 'hero.jpg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' });
      expect(await failure(root)).toMatch(/hero\.jpg is not a JPEG, PNG, WebP or AVIF picture/);
    });

    it('a picture with more pixels than the limit, naming the file', async () => {
      const root = app({ 'hero.jpg': await picture(1000, 500) });
      expect(await failure(root, { internals: { limitInputPixels: 1000 } })).toMatch(/hero\.jpg.*pixel/);
    });

    it('a file outside the app', async () => {
      const root = app({ 'app/main.js': "import image from '../outside.jpg?image';\nexport const images = [image];\n", 'outside.jpg': await picture(10, 10) });
      const inner = join(root, 'app');
      link(inner);
      expect(await failure(inner)).toMatch(/outside the app/);
    });

    it('a file `server.fs.deny` names', async () => {
      const root = app({ 'private/hero.jpg': await picture(10, 10) }, { entry: ['./private/hero.jpg?image'] });
      expect(await failure(root, { fs: { deny: ['**/private/**'] } })).toMatch(/denied by `server\.fs`/);
    });

    it('a broken SVG under a raster name, without loading sharp', async () => {
      const root = app({ 'broken.jpg': '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><oops' }, { entry: ['./broken.jpg?image'], withSharp: false });
      // `pnpm run` puts sharp on `NODE_PATH`: a module name that exists nowhere proves it is never loaded.
      expect(await failure(root, { internals: { sharpModule: 'sharp-that-is-not-installed' } })).toMatch(/broken\.jpg is not a JPEG, PNG, WebP or AVIF picture\. SVG and GIF are not processed/);
    });

    it('an SVG with a byte order mark under a raster name, with the hint', async () => {
      const root = app({ 'bom.png': Buffer.from('\uFEFF<svg xmlns="http://www.w3.org/2000/svg"/>') }, { entry: ['./bom.png?image'], withSharp: false });
      expect(await failure(root, { internals: { sharpModule: 'sharp-that-is-not-installed' } })).toMatch(/bom\.png is not .*import it without `\?image`/);
    });

    it('a TIFF under a raster name', async () => {
      const root = app({ 'hero.png': Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0]) }, { entry: ['./hero.png?image'], withSharp: false });
      expect(await failure(root, { internals: { sharpModule: 'sharp-that-is-not-installed' } })).toMatch(/hero\.png is not a JPEG, PNG, WebP or AVIF picture\./);
    });

    it('a PNG of 20000 by 20000 pixels at the real limit, naming the file and its size', async () => {
      const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, sum]);
      };
      const header = Buffer.alloc(13);
      header.writeUInt32BE(20000, 0);
      header.writeUInt32BE(20000, 4);
      header.set([8, 0, 0, 0, 0], 8);
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(1))), chunk('IEND', Buffer.alloc(0))]);
      const root = app({ 'huge.png': png }, { entry: ['./huge.png?image'] });
      expect(await failure(root)).toMatch(/huge\.png has 20000×20000 pixels/);
    });

    it('a symlink that points out of the app', async () => {
      const root = app({ 'app/main.js': "import image from './link.jpg?image';\nexport const images = [image];\n", 'outside.jpg': await picture(10, 10) });
      const inner = join(root, 'app');
      link(inner);
      symlinkSync(join(root, 'outside.jpg'), join(inner, 'link.jpg'));
      expect(await failure(inner)).toMatch(/outside the app/);
    });

    it('a relative base', async () => {
      const root = app({ 'hero.jpg': await picture(10, 10) });
      expect(await failure(root, { base: './' })).toMatch(/needs an absolute `base`/);
    });

    it('a missing file', async () => {
      const root = app({}, { entry: ['./nowhere.jpg?image'] });
      expect(await failure(root)).toMatch(/nowhere\.jpg/);
    });

    it('an import without sharp, saying how to add it', async () => {
      const root = app({ 'hero.jpg': await picture(10, 10) }, { withSharp: false });
      // `pnpm run` puts the repository's packages on `NODE_PATH`, where `sharp` would be found: ask for a name that exists nowhere.
      const message = await failure(root, { internals: { sharpModule: 'sharp-that-is-not-installed' } });
      expect(message).toMatch(/needs sharp: pnpm add -D sharp/);
      expect(message).not.toContain('Cannot find module');
    });
  });

  it('needs no sharp when nothing imports `?image`', async () => {
    const root = app({ 'main.js': 'export const images = [];\n' }, { withSharp: false });
    expect((await run(root)).images).toEqual([]);
  });
});
