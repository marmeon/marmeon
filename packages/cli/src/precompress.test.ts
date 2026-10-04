import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { precompressAssets } from './precompress.ts';

const dir = mkdtempSync(join(tmpdir(), 'bespoke-precompress-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('bespoke build — precompressed assets (E162)', () => {
  it('writes .br and .gz next to the compressible files — the same bytes once decompressed; never for images or what does not shrink', async () => {
    const script = `export const text = ${JSON.stringify('lorem ipsum '.repeat(300))};`;
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'index-Ab1.js'), script);
    writeFileSync(join(dir, 'nested/style-Cd2.css'), `.a{color:red}\n`.repeat(200));
    writeFileSync(join(dir, 'logo-Ef3.png'), Buffer.alloc(2000, 7));
    writeFileSync(join(dir, 'tiny-Gh4.js'), 'x');
    const result = await precompressAssets(dir);
    expect(result.files).toBe(2);
    expect(result.brotliBytes).toBeLessThan(result.bytes / 10);
    expect(brotliDecompressSync(readFileSync(join(dir, 'index-Ab1.js.br'))).toString()).toBe(script);
    expect(gunzipSync(readFileSync(join(dir, 'index-Ab1.js.gz'))).toString()).toBe(script);
    expect(readdirSync(join(dir, 'nested')).sort()).toEqual(['style-Cd2.css', 'style-Cd2.css.br', 'style-Cd2.css.gz']);
    expect(readdirSync(dir).filter((file) => file.startsWith('logo') || file.startsWith('tiny')).sort()).toEqual(['logo-Ef3.png', 'tiny-Gh4.js']);
    // Again (a second build into the same folder): the variants are not compressed once more.
    expect((await precompressAssets(dir)).files).toBe(2);
  });

  it('a build without assets has nothing to compress', async () => {
    expect(await precompressAssets(join(dir, 'missing'))).toEqual({ files: 0, bytes: 0, brotliBytes: 0 });
  });
});
