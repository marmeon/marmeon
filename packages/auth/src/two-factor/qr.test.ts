import { createHash } from 'node:crypto';
import jsQRModule from 'jsqr';
import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';

// jsqr is CommonJS with a `default` export: under NodeNext the import is the module object, in Vitest it is already the function.
const jsQR = ((jsQRModule as unknown as { default?: typeof jsQRModule }).default ?? jsQRModule) as unknown as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
import { qrPath } from './qr.ts';

const uri = 'otpauth://totp/Acme:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA1&digits=6&period=30';

describe('qrPath', () => {
  it('is deterministic for a known URI', () => {
    const { size, path } = qrPath(uri);
    expect(size).toBe(45); // version 7 at error correction M
    expect(createHash('sha256').update(path).digest('hex')).toBe('16ee164bd596e46613dea913eeae8d058b02fe29939411dba16a9dccaa6391aa');
    expect(qrPath(uri)).toEqual({ size, path });
  });

  it('draws runs of dark modules inside the grid, with no quiet zone', () => {
    const { size, path } = qrPath(uri);
    expect(path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
    expect(path.startsWith('M0 0h7')).toBe(true); // the top-left finder pattern starts at the corner
    for (const [, x, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      expect(Number(x) + Number(run)).toBeLessThanOrEqual(size);
      expect(Number(y)).toBeLessThan(size);
    }
  });

  /** The grid the path draws, rebuilt from its runs. */
  function matrixOf({ size, path }: { size: number; path: string }): boolean[][] {
    const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
    for (const [, x, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(run); i++) grid[Number(y)]![Number(x) + i] = true;
    }
    return grid;
  }

  it('draws exactly the modules uqr encoded', () => {
    expect(matrixOf(qrPath(uri))).toEqual(encode(uri, { ecc: 'M', border: 0 }).data);
  });

  it('is read back as the same text by an independent decoder', () => {
    const { size, path } = qrPath(uri);
    const grid = matrixOf({ size, path });
    const scale = 4;
    const quiet = 4; // modules of white around the code
    const side = (size + 2 * quiet) * scale;
    const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!grid[y]![x]) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) pixels.fill(0, (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4, (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4 + 3);
        }
      }
    }
    expect(jsQR(pixels, side, side)?.data).toBe(uri);
  });

  it('gives different texts different codes', () => {
    expect(qrPath(`${uri}1`).path).not.toBe(qrPath(uri).path);
  });
});
