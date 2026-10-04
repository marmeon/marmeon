import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/** What is worth compressing — text, scripts, styles, JSON, SVG, WebAssembly; never images, fonts or what is compressed already. */
export const COMPRESSIBLE_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.map', '.svg', '.txt', '.xml', '.wasm', '.webmanifest']);

export interface PrecompressResult {
  /** The files a `.br` and a `.gz` were written for. */
  readonly files: number;
  /** Bytes of those files, and of their `.br` versions. */
  readonly bytes: number;
  readonly brotliBytes: number;
}

/**
 * Writes `<file>.br` (Brotli, quality 11) and `<file>.gz` (gzip, level 9) next to every compressible file of the build's assets
 * (E162) — once, at build time, at the highest levels: the server sends them by `Accept-Encoding` and compresses nothing per
 * request (documents never: BREACH). A file that does not get smaller keeps no variant.
 */
export async function precompressAssets(dir: string): Promise<PrecompressResult> {
  if (!existsSync(dir)) return { files: 0, bytes: 0, brotliBytes: 0 };
  const names = (await readdir(dir, { recursive: true })).filter((name) => COMPRESSIBLE_EXTENSIONS.has(extname(name)));
  const results = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const source = await readFile(path);
      const [br, gz] = await Promise.all([
        brotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: source.length } }),
        gzipped(source, { level: constants.Z_BEST_COMPRESSION }),
      ]);
      if (br.length >= source.length) return undefined;
      await Promise.all([writeFile(`${path}.br`, br), gz.length < source.length ? writeFile(`${path}.gz`, gz) : undefined]);
      return { bytes: source.length, brotliBytes: br.length };
    }),
  );
  const written = results.filter((result) => result !== undefined);
  return {
    files: written.length,
    bytes: written.reduce((sum, result) => sum + result.bytes, 0),
    brotliBytes: written.reduce((sum, result) => sum + result.brotliBytes, 0),
  };
}
