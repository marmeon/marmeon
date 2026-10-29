import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { imageDimensions } from './dimensions.ts';

const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((part) => [...part]));

const png = (width: number, height: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), text('IHDR'), be32(width), be32(height), [8, 6, 0, 0, 0]);
const gif = (width: number, height: number) => bytes(text('GIF89a'), le16(width), le16(height), [0, 0, 0]);

function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Uint8Array {
  let body: number[];
  if (kind === 'VP8 ') body = [0x10, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)];
  else if (kind === 'VP8L') {
    const w = width - 1;
    const h = height - 1;
    body = [0x2f, w & 255, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 15];
  } else body = [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  return bytes(text('RIFF'), [0, 0, 0, 0], text('WEBP'), text(kind), [body.length, 0, 0, 0], body);
}

/** An EXIF segment whose first directory holds one orientation entry. */
function exif(orientation: number, order: 'II' | 'MM'): number[] {
  const little = order === 'II';
  const u16 = little ? le16 : be16;
  const u32 = (n: number) => (little ? [...le16(n), ...le16(n >>> 16)] : be32(n));
  const tiff = [...text(order), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const data = [...text('Exif'), 0, 0, ...tiff];
  return [0xff, 0xe1, ...be16(data.length + 2), ...data];
}

function jpeg(width: number, height: number, before: number[][] = []): Uint8Array {
  const sof = [0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return bytes([0xff, 0xd8], ...before, sof, [0xff, 0xda, 0, 2]);
}

const box = (type: string, ...body: number[][]) => {
  const content = body.flat();
  return [...be32(content.length + 8), ...text(type), ...content];
};
/**
 * An AVIF whose primary item (id 7) has the size and rotation given. Properties before it in `ipco` belong to other items —
 * a 512 × 512 tile, a thumbnail — and a rotation that is not the primary's; `wide` writes 32-bit ids and 15-bit indexes.
 */
function avif(width: number, height: number, rotation?: number, { others = true, wide = false } = {}): Uint8Array {
  const ispe = (w: number, h: number) => box('ispe', [0, 0, 0, 0], be32(w), be32(h));
  const properties = [...(others ? [ispe(512, 512), box('irot', [3]), ispe(64, 48)] : []), ispe(width, height), ...(rotation === undefined ? [] : [box('irot', [rotation])])];
  const first = others ? 3 : 0; // the primary's properties sit after the others'
  const mine = [first + 1, ...(rotation === undefined ? [] : [first + 2])];
  const association = wide ? mine.flatMap((index) => be16(index)) : mine;
  const ipma = box('ipma', [wide ? 1 : 0, 0, 0, wide ? 1 : 0], be32(others ? 2 : 1), ...(others ? [wide ? be32(8) : be16(8), [1], wide ? [0x00, 0x01] : [1]] : []), wide ? be32(7) : be16(7), [mine.length], association);
  return bytes(
    box('ftyp', text('avif'), [0, 0, 0, 0], text('avif'), text('mif1')),
    box('meta', [0, 0, 0, 0], box('hdlr', [0, 0, 0, 0]), box('pitm', [wide ? 1 : 0, 0, 0, 0], wide ? be32(7) : be16(7)), box('iprp', box('ipco', ...properties), ipma)),
  );
}

describe('imageDimensions()', () => {
  it('reads PNG and GIF', () => {
    expect(imageDimensions(png(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(gif(320, 200), 'image/gif')).toEqual({ width: 320, height: 200 });
  });

  it.each(['VP8 ', 'VP8L', 'VP8X'] as const)('reads WebP of kind %s', (kind) => {
    expect(imageDimensions(webp(kind, 1234, 567), 'image/webp')).toEqual({ width: 1234, height: 567 });
  });

  it('reads JPEG, skipping segments before the frame', () => {
    const app0 = [0xff, 0xe0, ...be16(16), ...Array.from<number>({ length: 14 }).fill(0)];
    expect(imageDimensions(jpeg(800, 600, [app0]), 'image/jpeg')).toEqual({ width: 800, height: 600 });
  });

  it.each([
    [1, 'II', false],
    [3, 'MM', false],
    [6, 'II', true],
    [8, 'MM', true],
  ] as const)('applies EXIF orientation %i (%s)', (orientation, order, swapped) => {
    const found = imageDimensions(jpeg(800, 600, [exif(orientation, order)]), 'image/jpeg');
    expect(found).toEqual(swapped ? { width: 600, height: 800 } : { width: 800, height: 600 });
  });

  it('reads AVIF, and swaps for a quarter turn', () => {
    expect(imageDimensions(avif(400, 300), 'image/avif')).toEqual({ width: 400, height: 300 });
    expect(imageDimensions(avif(400, 300, 1), 'image/avif')).toEqual({ width: 300, height: 400 });
    expect(imageDimensions(avif(400, 300, 2), 'image/avif')).toEqual({ width: 400, height: 300 });
  });

  it('reads the primary image of an AVIF, not the first size in the file (tiles, thumbnails)', () => {
    for (const wide of [false, true]) {
      expect(imageDimensions(avif(1280, 320, undefined, { wide }), 'image/avif')).toEqual({ width: 1280, height: 320 });
      expect(imageDimensions(avif(1280, 320, 1, { wide }), 'image/avif')).toEqual({ width: 320, height: 1280 });
    }
  });

  it('reads a grid AVIF written by an encoder: 1280 × 320 in tiles of 512 × 512', () => {
    const file = new Uint8Array(readFileSync(new URL('../__fixtures__/grid.avif', import.meta.url)));
    expect(imageDimensions(file, 'image/avif')).toEqual({ width: 1280, height: 320 });
  });

  it('an AVIF without the primary item, its associations or its size is undefined', () => {
    const file = avif(400, 300);
    const without = (type: string) => {
      const at = text(type);
      const index = file.findIndex((_, i) => at.every((c, j) => file[i + j] === c));
      const copy = Uint8Array.from(file);
      copy.set(text('free'), index); // the box stays, but is no longer that kind
      return copy;
    };
    expect(imageDimensions(without('pitm'), 'image/avif')).toBeUndefined();
    expect(imageDimensions(without('ipma'), 'image/avif')).toBeUndefined();
    expect(imageDimensions(without('iprp'), 'image/avif')).toBeUndefined();
  });

  it('is undefined for another type and for a mime that does not match the bytes', () => {
    expect(imageDimensions(new TextEncoder().encode('hello, not an image'), 'image/png')).toBeUndefined();
    expect(imageDimensions(png(1, 1), 'application/pdf')).toBeUndefined();
    expect(imageDimensions(png(1, 1), 'image/jpeg')).toBeUndefined();
    expect(imageDimensions(png(1, 1), 'image/svg+xml')).toBeUndefined();
  });

  describe('damaged files', () => {
    const files: [string, Uint8Array, string][] = [
      ['png', png(640, 480), 'image/png'],
      ['gif', gif(320, 200), 'image/gif'],
      ['webp', webp('VP8X', 100, 100), 'image/webp'],
      ['webp lossless', webp('VP8L', 100, 100), 'image/webp'],
      ['jpeg', jpeg(800, 600, [exif(6, 'II')]), 'image/jpeg'],
      ['avif', avif(400, 300, 1), 'image/avif'],
    ];

    it.each(files)('a cut-off %s is undefined at every length, never a throw', (_name, file, mime) => {
      for (let length = 0; length < file.length - 1; length++) {
        const cut = imageDimensions(file.subarray(0, length), mime);
        // A file cut after the part that holds the size may still answer — but never with another size.
        if (cut !== undefined) expect(cut).toEqual(imageDimensions(file, mime));
      }
      expect(imageDimensions(new Uint8Array(0), mime)).toBeUndefined();
      expect(imageDimensions(file.subarray(0, 8), mime)).toBeUndefined();
    });

    it('a JPEG cut inside its frame header is undefined', () => {
      const file = jpeg(800, 600);
      expect(imageDimensions(file.subarray(0, 12), 'image/jpeg')).toBeUndefined();
    });

    it('zero sides are undefined', () => {
      expect(imageDimensions(png(0, 10), 'image/png')).toBeUndefined();
      expect(imageDimensions(gif(10, 0), 'image/gif')).toBeUndefined();
      expect(imageDimensions(jpeg(0, 10), 'image/jpeg')).toBeUndefined();
      expect(imageDimensions(avif(0, 10), 'image/avif')).toBeUndefined();
    });

    it('a side beyond what the format can hold is undefined', () => {
      expect(imageDimensions(png(0xffffffff, 10), 'image/png')).toBeUndefined();
    });

    it('a JPEG segment longer than the file is undefined', () => {
      expect(imageDimensions(bytes([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 1, 2, 3, 4]), 'image/jpeg')).toBeUndefined();
    });

    it('a JPEG of endless empty segments ends without a frame', () => {
      const body = new Uint8Array(200_000);
      for (let i = 0; i < body.length; i += 4) body.set([0xff, 0xe0, 0x00, 0x02], i); // each segment is only its length bytes
      expect(imageDimensions(bytes([0xff, 0xd8], body), 'image/jpeg')).toBeUndefined();
    });

    it('a JPEG of fill bytes, and of markers without length, ends', () => {
      expect(imageDimensions(bytes([0xff, 0xd8], Array.from<number>({ length: 100_000 }).fill(0xff)), 'image/jpeg')).toBeUndefined();
      const flags = new Uint8Array(100_000);
      for (let i = 0; i < flags.length; i += 2) flags.set([0xff, 0x01], i);
      expect(imageDimensions(bytes([0xff, 0xd8], flags), 'image/jpeg')).toBeUndefined();
    });

    it('a JPEG with a segment length below two is undefined', () => {
      expect(imageDimensions(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]), 'image/jpeg')).toBeUndefined();
    });

    it('an EXIF directory that points outside the segment keeps the plain size', () => {
      const wild = exif(6, 'II');
      wild.splice(10 + 4, 4, 0xff, 0xff, 0xff, 0x7f); // the offset of the first directory
      expect(imageDimensions(jpeg(800, 600, [wild]), 'image/jpeg')).toEqual({ width: 800, height: 600 });
    });

    it('an EXIF directory of 65 535 entries stops at the segment', () => {
      const many = exif(6, 'MM');
      many.splice(18, 4, 0xff, 0xff, 0x01, 0x10); // the count, then a tag that is not the orientation
      expect(imageDimensions(jpeg(800, 600, [many]), 'image/jpeg')).toEqual({ width: 800, height: 600 });
    });

    it('AVIF boxes that point at themselves, or are huge, end without a size', () => {
      const selfPointing = bytes(box('ftyp', text('avif')), [0, 0, 0, 8], text('meta'));
      expect(imageDimensions(selfPointing, 'image/avif')).toBeUndefined();
      const huge = bytes(box('ftyp', text('avif')), be32(0xffffffff), text('meta'), [0, 0, 0, 0]);
      expect(imageDimensions(huge, 'image/avif')).toBeUndefined();
      const zeroLength = bytes(box('ftyp', text('avif')), [0, 0, 0, 0], text('free'));
      expect(imageDimensions(zeroLength, 'image/avif')).toBeUndefined();
    });

    it('AVIF boxes nested deeper than eight levels are not followed', () => {
      let nested = box('ispe', [0, 0, 0, 0], be32(10), be32(10));
      for (let i = 0; i < 20; i++) nested = box('iprp', nested);
      expect(imageDimensions(bytes(box('ftyp', text('avif')), box('meta', [0, 0, 0, 0], nested)), 'image/avif')).toBeUndefined();
    });

    it('thousands of tiny AVIF boxes end', () => {
      const tiny = new Uint8Array(80_000);
      for (let i = 0; i < tiny.length; i += 8) tiny.set([0, 0, 0, 8, ...text('free')], i);
      expect(imageDimensions(bytes(box('ftyp', text('avif')), tiny), 'image/avif')).toBeUndefined();
    });

    it('a 64-bit AVIF box size with a high word is refused', () => {
      expect(imageDimensions(bytes(box('ftyp', text('avif')), [0, 0, 0, 1], text('meta'), [0, 0, 0, 1, 0, 0, 0, 0]), 'image/avif')).toBeUndefined();
    });

    it('random bytes never throw and never hang', () => {
      let seed = 12345;
      const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 255;
      for (let round = 0; round < 300; round++) {
        const file = new Uint8Array(300 + (round % 7) * 50).map(next);
        for (const [, sample, mime] of files) {
          const mixed = Uint8Array.from(file);
          mixed.set(sample.subarray(0, 40 + (round % 30)));
          expect(() => imageDimensions(mixed, mime)).not.toThrow();
        }
      }
    });
  });
});
