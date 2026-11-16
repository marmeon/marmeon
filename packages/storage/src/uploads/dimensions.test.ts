import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIMENSION_BYTES, imageDimensions } from './dimensions.ts';

const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((part) => [...part]));

const png = (width: number, height: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), text('IHDR'), be32(width), be32(height), [8, 6, 0, 0, 0]);
/** A GIF whose logical screen is `width` × `height`; its first frame is `frame` (the screen's size when not given), behind `before` blocks. */
const gif = (width: number, height: number, { frame = [width, height], at = [0, 0], version = '89a', before = [] as number[][] } = {}) =>
  bytes(text(`GIF${version}`), le16(width), le16(height), [0, 0, 0], ...before, [0x2c, ...le16(at[0]!), ...le16(at[1]!), ...le16(frame[0]!), ...le16(frame[1]!), 0], [0x3b]);

function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Uint8Array {
  let body: number[];
  if (kind === 'VP8 ') body = [0x10, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)];
  else if (kind === 'VP8L') {
    const w = width - 1;
    const h = height - 1;
    body = [0x2f, w & 255, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 15];
  } else body = [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  const chunk = [...text(kind), body.length, 0, 0, 0, ...body];
  // An extended file carries the coded image after its VP8X chunk, as a writer makes it.
  return bytes(text('RIFF'), [0, 0, 0, 0], text('WEBP'), chunk, ...(kind === 'VP8X' ? [[...webp('VP8L', width, height).subarray(12)]] : []));
}
/** The `VP8L` chunk of a coded image of `width` × `height`. */
const coded = (width: number, height: number) => [...webp('VP8L', width, height).subarray(12), 0]; // padded to an even length, as chunks are

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

  it.each(['87a', '89a'])('GIF%s: a first frame larger than the logical screen is the size, as a decoder shows it', (version) => {
    expect(imageDimensions(gif(1, 1, { frame: [20_000, 20_000], version }), 'image/gif')).toEqual({ width: 20_000, height: 20_000 });
    expect(imageDimensions(gif(300, 5, { frame: [5, 400], version }), 'image/gif')).toEqual({ width: 300, height: 400 });
  });

  it('GIF: a first frame offset beyond the screen makes the canvas — its right and bottom edge count', () => {
    expect(imageDimensions(gif(1, 1, { frame: [1, 1], at: [20_000, 30_000] }), 'image/gif')).toEqual({ width: 20_001, height: 30_001 });
    expect(imageDimensions(gif(100, 100, { frame: [10, 10], at: [20, 30] }), 'image/gif')).toEqual({ width: 100, height: 100 });
  });

  it('GIF: a graphic control block that is not four bytes is damaged', () => {
    expect(imageDimensions(gif(10, 10, { before: [[0x21, 0xf9, 3, 0, 0, 0, 0]] }), 'image/gif')).toBeUndefined();
    expect(imageDimensions(gif(10, 10, { before: [[0x21, 0xf9, 4, 0, 0, 0, 0, 0]] }), 'image/gif')).toEqual({ width: 10, height: 10 });
  });

  it('GIF: blocks before the first frame are walked past — a colour table, an extension with sub-blocks', () => {
    const table = bytes(text('GIF89a'), le16(10), le16(10), [0x81, 0, 0], Array.from({ length: 12 }, () => 0), [0x21, 0xf9, 4, 0, 0, 0, 0, 0], [0x21, 0xff, 3, 1, 2, 3, 2, 9, 9, 0], [0x2c, 0, 0, 0, 0, ...le16(5000), ...le16(6000), 0], [0x3b]);
    expect(imageDimensions(table, 'image/gif')).toEqual({ width: 5000, height: 6000 });
  });

  it('GIF: no image descriptor in the bytes read — a header alone, a trailer first, a block cut off — is undefined', () => {
    expect(imageDimensions(bytes(text('GIF89a'), le16(10), le16(10), [0, 0, 0]), 'image/gif')).toBeUndefined();
    expect(imageDimensions(bytes(text('GIF89a'), le16(10), le16(10), [0, 0, 0, 0x3b]), 'image/gif')).toBeUndefined();
    expect(imageDimensions(bytes(text('GIF89a'), le16(10), le16(10), [0, 0, 0, 0x21, 0xf9, 200, 1, 2]), 'image/gif')).toBeUndefined();
    expect(imageDimensions(bytes(text('GIF89a'), le16(10), le16(10), [0, 0, 0, 0x2c, 0, 0, 0, 0, 5]), 'image/gif')).toBeUndefined();
  });

  it('AVIF sequence: a file with the brand avis, or a moov, has tracks nothing here measures — undefined, whatever its item says', () => {
    const base = avif(1, 1);
    const plain = box('ftyp', text('avif'), [0, 0, 0, 0], text('avif'), text('mif1'));
    const rest = base.subarray(plain.length);
    expect(imageDimensions(bytes(plain, rest), 'image/avif')).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(bytes(box('ftyp', text('avif'), [0, 0, 0, 0], text('avif'), text('avis')), rest), 'image/avif')).toBeUndefined(); // compatible brand
    expect(imageDimensions(bytes(box('ftyp', text('avis'), [0, 0, 0, 0], text('mif1')), rest), 'image/avif')).toBeUndefined(); // major brand
    expect(imageDimensions(bytes(base, box('moov', box('trak', box('tkhd', [0, 0, 0, 0])))), 'image/avif')).toBeUndefined();
    expect(imageDimensions(bytes(base, box('moov')), 'image/avif')).toBeUndefined();
  });

  it('AVIF: whatever is not seen is not trusted — boxes past the cap, a cut meta, a meta that lies past the bytes read, a property index beyond the list', () => {
    const base = avif(1, 1);
    const plain = box('ftyp', text('avif'), [0, 0, 0, 0], text('avif'), text('mif1'));
    const free = (count: number) => Array.from({ length: count }, () => box('free')).flat();
    // 1100 boxes before the moov that would show a large track: the walk stops at its cap and says so.
    expect(imageDimensions(bytes(base, free(1100), box('moov')), 'image/avif')).toBeUndefined();
    expect(imageDimensions(bytes(plain, free(1100), base.subarray(plain.length)), 'image/avif')).toBeUndefined();
    expect(imageDimensions(bytes(plain, free(10), base.subarray(plain.length)), 'image/avif')).toEqual({ width: 1, height: 1 });
    // The item is past the bytes read: a media box that states more than the bytes given comes first, or the meta box is cut.
    expect(imageDimensions(bytes(plain, be32(300_000), text('mdat'), Array.from({ length: 100 }, () => 0)), 'image/avif')).toBeUndefined();
    expect(imageDimensions(base.subarray(0, base.length - 5), 'image/avif')).toBeUndefined();
    // A property the primary item names that the list does not hold may be the size; a later ispe does not stand in for it.
    const ispe = box('ispe', [0, 0, 0, 0], be32(10), be32(10));
    const ipma = box('ipma', [0, 0, 0, 0], be32(1), be16(7), [2], [5, 1]);
    const named = bytes(plain, box('meta', [0, 0, 0, 0], box('pitm', [0, 0, 0, 0], be16(7)), box('iprp', box('ipco', ispe), ipma)));
    expect(imageDimensions(named, 'image/avif')).toBeUndefined();
    const inList = bytes(plain, box('meta', [0, 0, 0, 0], box('pitm', [0, 0, 0, 0], be16(7)), box('iprp', box('ipco', ispe), box('ipma', [0, 0, 0, 0], be32(1), be16(7), [2], [0, 1]))));
    expect(imageDimensions(inList, 'image/avif')).toEqual({ width: 10, height: 10 });
  });

  it('AVIF: a list that stops early, a box that is cut, or a 64-bit size beyond 4 GiB says so — the item found before it is not trusted', () => {
    const plain = box('ftyp', text('avif'), [0, 0, 0, 0], text('avif'), text('mif1'));
    const free = (count: number) => Array.from({ length: count }, () => box('free')).flat();
    const ispe = box('ispe', [0, 0, 0, 0], be32(10), be32(10));
    const pitm = box('pitm', [0, 0, 0, 0], be16(7));
    const ipma = box('ipma', [0, 0, 0, 0], be32(1), be16(7), [1], [1]);
    const made = ({ ipco = box('ipco', ispe), props = [] as number[][], inMeta = [] as number[][], assoc = ipma } = {}) => bytes(plain, box('meta', [0, 0, 0, 0], ...inMeta, pitm, box('iprp', ...props, ipco, assoc)));
    expect(imageDimensions(made(), 'image/avif')).toEqual({ width: 10, height: 10 });
    expect(imageDimensions(made({ ipco: box('ipco', ispe, free(10)) }), 'image/avif')).toEqual({ width: 10, height: 10 });
    expect(imageDimensions(made({ ipco: box('ipco', ispe, free(1100)) }), 'image/avif')).toBeUndefined(); // ipco: more boxes than the cap
    expect(imageDimensions(made({ inMeta: [free(1100)] }), 'image/avif')).toBeUndefined(); // meta: pitm lies past the cap
    expect(imageDimensions(made({ props: [free(1100)] }), 'image/avif')).toBeUndefined(); // iprp: ipco lies past the cap
    const longer = (made: number[], extra: number) => [...be32(((made[0]! << 24) | (made[1]! << 16) | (made[2]! << 8) | made[3]!) + extra), ...made.slice(4)];
    expect(imageDimensions(made({ assoc: longer(ipma, 100) }), 'image/avif')).toBeUndefined(); // ipma states more than iprp holds
    // Both boxes are found, but the list behind them is cut short by the cap: what lies past it is not known.
    expect(imageDimensions(bytes(plain, box('meta', [0, 0, 0, 0], pitm, box('iprp', box('ipco', ispe), ipma), free(1100))), 'image/avif')).toBeUndefined();
    expect(imageDimensions(bytes(plain, box('meta', [0, 0, 0, 0], pitm, box('iprp', box('ipco', ispe), ipma, free(1100)))), 'image/avif')).toBeUndefined();
    const base = made();
    const cutIprp = bytes(plain, box('meta', [0, 0, 0, 0], pitm, longer(box('iprp', box('ipco', ispe), ipma), 100)));
    expect(imageDimensions(cutIprp, 'image/avif')).toBeUndefined(); // iprp states more than meta holds
    // The item sits before a box the walk cannot step over: nothing after it may be taken as the whole file.
    expect(imageDimensions(bytes(base, [0, 0, 0, 1], text('free'), be32(1), be32(0)), 'image/avif')).toBeUndefined(); // 64-bit size above 4 GiB
    expect(imageDimensions(bytes(base, [0, 0, 0, 4], text('free')), 'image/avif')).toBeUndefined(); // shorter than its header
    expect(imageDimensions(bytes(base, free(1100)), 'image/avif')).toBeUndefined();
  });

  it('JPEG and GIF: a walk that reaches its cap of blocks is undefined, not a guess', () => {
    const segment = [0xff, 0xe2, ...be16(2)];
    expect(imageDimensions(jpeg(800, 600, Array.from({ length: 10 }, () => segment)), 'image/jpeg')).toEqual({ width: 800, height: 600 });
    expect(imageDimensions(jpeg(800, 600, Array.from({ length: 1100 }, () => segment)), 'image/jpeg')).toBeUndefined();
    const extension = [0x21, 0xfe, 0];
    expect(imageDimensions(gif(10, 10, { before: Array.from({ length: 10 }, () => extension) }), 'image/gif')).toEqual({ width: 10, height: 10 });
    expect(imageDimensions(gif(10, 10, { before: Array.from({ length: 1100 }, () => extension) }), 'image/gif')).toBeUndefined();
  });

  it.each(['VP8 ', 'VP8L', 'VP8X'] as const)('reads WebP of kind %s', (kind) => {
    expect(imageDimensions(webp(kind, 1234, 567), 'image/webp')).toEqual({ width: 1234, height: 567 });
  });

  describe('orientation of a file whose EXIF turns it a quarter', () => {
    const exifAfter = (width: number, height: number, segment: number[]) => {
      const file = jpeg(width, height); // SOI, frame, SOS marker with its length
      const sos = file.length - 4;
      return bytes(file.subarray(0, sos), segment, file.subarray(sos));
    };

    it('JPEG: an Exif segment before or after the frame turns a 10 × 200 file into 200 × 10', () => {
      expect(imageDimensions(jpeg(10, 200, [exif(6, 'II')]), 'image/jpeg')).toEqual({ width: 200, height: 10 });
      expect(imageDimensions(exifAfter(10, 200, exif(6, 'MM')), 'image/jpeg')).toEqual({ width: 200, height: 10 });
      expect(imageDimensions(exifAfter(10, 200, exif(3, 'MM')), 'image/jpeg')).toEqual({ width: 10, height: 200 });
    });

    it('JPEG: a second Exif segment, an unreadable one, and a scan that is not in the bytes are undefined', () => {
      expect(imageDimensions(exifAfter(10, 200, [...exif(1, 'II'), ...exif(6, 'II')]), 'image/jpeg')).toBeUndefined();
      expect(imageDimensions(exifAfter(10, 200, exif(9, 'II')), 'image/jpeg')).toBeUndefined();
      const file = jpeg(10, 200);
      expect(imageDimensions(file.subarray(0, file.length - 4), 'image/jpeg')).toBeUndefined(); // no start of scan
    });

    const chunk = (type: string, data: number[]) => [...be32(data.length), ...text(type), ...data, 0, 0, 0, 0];
    const tiff = (orientation: number) => exif(orientation, 'MM').slice(10); // the TIFF structure of an Exif segment

    it('PNG: an eXIf chunk before IDAT turns it; one that cannot be read, or two, are undefined; one after IDAT is not a decoder’s', () => {
      const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text('IHDR'), ...be32(10), ...be32(200), 8, 6, 0, 0, 0, 0, 0, 0, 0];
      const idat = chunk('IDAT', [0]);
      expect(imageDimensions(bytes(head, chunk('eXIf', tiff(6)), idat), 'image/png')).toEqual({ width: 200, height: 10 });
      expect(imageDimensions(bytes(head, chunk('eXIf', tiff(1)), idat), 'image/png')).toEqual({ width: 10, height: 200 });
      expect(imageDimensions(bytes(head, chunk('eXIf', [1, 2, 3]), idat), 'image/png')).toBeUndefined();
      expect(imageDimensions(bytes(head, chunk('eXIf', tiff(1)), chunk('eXIf', tiff(6)), idat), 'image/png')).toBeUndefined();
      expect(imageDimensions(bytes(head, idat, chunk('eXIf', tiff(6))), 'image/png')).toEqual({ width: 10, height: 200 });
      // The bytes ran out in a file that goes on: more chunks may follow.
      expect(imageDimensions(bytes(head, chunk('eXIf', tiff(6)), new Uint8Array(DIMENSION_BYTES)), 'image/png')).toBeUndefined();
    });

    it.each([
      ['RATIONAL', 5, 1],
      ['UNDEFINED', 7, 1],
      ['SHORT with count 2', 3, 2],
    ])('an orientation entry that is a %s, not a SHORT with count 1, is undefined in a JPEG, a PNG and a WebP', (_name, type, count) => {
      const odd = (tiffBytes: number[]) => tiffBytes.map((value, index) => (index === 12 ? 0 : index === 13 ? type : index >= 14 && index <= 17 ? (index === 17 ? count : 0) : value)); // type at 12, count at 14..17 (big-endian)
      expect(odd(tiff(6)).slice(12, 18)).toEqual([0, type, 0, 0, 0, count]);
      const segment = (data: number[]) => [0xff, 0xe1, ...be16(data.length + 8), ...text('Exif'), 0, 0, ...data];
      expect(imageDimensions(jpeg(10, 200, [segment(odd(tiff(6)))]), 'image/jpeg')).toBeUndefined();
      expect(imageDimensions(jpeg(10, 200, [segment(tiff(6))]), 'image/jpeg')).toEqual({ width: 200, height: 10 });
      const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text('IHDR'), ...be32(10), ...be32(200), 8, 6, 0, 0, 0, 0, 0, 0, 0];
      expect(imageDimensions(bytes(head, chunk('eXIf', odd(tiff(6))), chunk('IDAT', [0])), 'image/png')).toBeUndefined();
      const vp8x = [...text('VP8X'), 10, 0, 0, 0, 0x08, 0, 0, 0, ...le24(9), ...le24(199)];
      const data = odd(tiff(6));
      const webp = bytes(text('RIFF'), [0, 0, 0, 0], text('WEBP'), vp8x, coded(10, 200), text('EXIF'), [data.length, 0, 0, 0], data);
      expect(imageDimensions(webp, 'image/webp')).toBeUndefined();
    });

    it('WebP: the coded image or the first animation frame counts beside the VP8X canvas, on each side', () => {
      const vp8x = (flags: number, width: number, height: number) => [...text('VP8X'), 10, 0, 0, 0, flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
      const riff = (...chunks: number[][]) => bytes(text('RIFF'), [0, 0, 0, 0], text('WEBP'), ...chunks);
      // A canvas of 1 × 1 over a coded image of 200 × 200: other decoders than a browser's decode the coded size.
      expect(imageDimensions(riff(vp8x(0, 1, 1), coded(200, 200)), 'image/webp')).toEqual({ width: 200, height: 200 });
      expect(imageDimensions(riff(vp8x(0, 300, 5), coded(200, 200)), 'image/webp')).toEqual({ width: 300, height: 200 });
      expect(imageDimensions(riff(vp8x(0, 1, 1), [...text('VP8 '), 10, 0, 0, 0, 0x10, 0, 0, 0x9d, 0x01, 0x2a, ...le16(200), ...le16(200)]), 'image/webp')).toEqual({ width: 200, height: 200 });
      expect(imageDimensions(riff(vp8x(0, 1, 1)), 'image/webp')).toBeUndefined(); // no coded image in the bytes read
      // An animation: the first frame's offset (twice its stored value) and size, behind a 1 × 1 canvas.
      const anmf = (x: number, y: number, width: number, height: number) => [...text('ANMF'), 16, 0, 0, 0, ...le24(x / 2), ...le24(y / 2), ...le24(width - 1), ...le24(height - 1), 0, 0, 0, 0, 0, 0, 0];
      expect(imageDimensions(riff(vp8x(0x02, 1, 1), anmf(0, 0, 200, 200)), 'image/webp')).toEqual({ width: 200, height: 200 });
      expect(imageDimensions(riff(vp8x(0x02, 1, 1), anmf(1000, 2000, 1, 1)), 'image/webp')).toEqual({ width: 1001, height: 2001 });
      expect(imageDimensions(riff(vp8x(0x02, 1, 1)), 'image/webp')).toBeUndefined(); // the first frame is not in the bytes read
    });

    it('PNG: a chunk before IDAT that does not fit in the bytes read is undefined — an eXIf could hide behind it', () => {
      const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text('IHDR'), ...be32(1), ...be32(1), 8, 6, 0, 0, 0, 0, 0, 0, 0];
      expect(imageDimensions(bytes(head, [...be32(262_144), ...text('tEXt'), 0, 0, 0, 0]), 'image/png')).toBeUndefined();
      expect(imageDimensions(bytes(head, [...be32(4), ...text('tEXt'), 1, 2, 3, 4, 0, 0, 0, 0], [...be32(0), ...text('IDAT')]), 'image/png')).toEqual({ width: 1, height: 1 });
    });

    it('PNG: with no IDAT in a short file, the eXIf chunk still turns it; fewer than 8 bytes after the last chunk is undefined', () => {
      const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text('IHDR'), ...be32(10), ...be32(200), 8, 6, 0, 0, 0, 0, 0, 0, 0];
      expect(imageDimensions(bytes(head, chunk('eXIf', tiff(6))), 'image/png')).toEqual({ width: 200, height: 10 });
      expect(imageDimensions(bytes(head, chunk('eXIf', tiff(6)), [0, 0, 0, 0, 0]), 'image/png')).toBeUndefined();
    });

    /** An Exif segment around `tiffBytes`, in a JPEG of 10 × 200. */
    const withTiff = (tiffBytes: number[]) => jpeg(10, 200, [[0xff, 0xe1, ...be16(tiffBytes.length + 8), ...text('Exif'), 0, 0, ...tiffBytes]]);
    const entry = (tag: number, value = 0) => [...be16(tag), ...be16(3), ...be32(1), ...be16(value), 0, 0];
    const directory = (entries: number[][], { order = 'MM', magic = 42 } = {}) => [...text(order), ...be16(magic), ...be32(8), ...be16(entries.length), ...entries.flat(), ...be32(0)];

    it('EXIF: a directory of more than 256 entries without the orientation, or with it past the 256th, an unknown byte order or a wrong magic number is undefined', () => {
      const other = (count: number) => Array.from({ length: count }, () => entry(0x0100));
      expect(imageDimensions(withTiff(directory([...other(3), entry(0x0112, 6)])), 'image/jpeg')).toEqual({ width: 200, height: 10 });
      expect(imageDimensions(withTiff(directory(other(300))), 'image/jpeg')).toBeUndefined();
      expect(imageDimensions(withTiff(directory([...other(256), entry(0x0112, 6)])), 'image/jpeg')).toBeUndefined();
      expect(imageDimensions(withTiff(directory([...other(255), entry(0x0112, 6)])), 'image/jpeg')).toEqual({ width: 200, height: 10 });
      expect(imageDimensions(withTiff(directory([entry(0x0112, 6)], { magic: 43 })), 'image/jpeg')).toBeUndefined();
      expect(imageDimensions(withTiff(directory([entry(0x0112, 6)], { order: 'XX' })), 'image/jpeg')).toBeUndefined();
    });

    it('JPEG: a second frame header, and a start of scan with no frame, are undefined', () => {
      const frame = [0xff, 0xc0, ...be16(17), 8, ...be16(200), ...be16(10), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
      expect(imageDimensions(bytes([0xff, 0xd8], frame, frame, [0xff, 0xda, 0, 2]), 'image/jpeg')).toBeUndefined();
      expect(imageDimensions(bytes([0xff, 0xd8], frame, [0xff, 0xda, 0, 2]), 'image/jpeg')).toEqual({ width: 10, height: 200 });
      expect(imageDimensions(bytes([0xff, 0xd8], [0xff, 0xda, 0, 2]), 'image/jpeg')).toBeUndefined();
    });

    it('WebP: an EXIF chunk named by the VP8X flag turns it; a flag whose chunk is not found, or cannot be read, is undefined', () => {
      const vp8x = (flags: number) => [...text('VP8X'), 10, 0, 0, 0, flags, 0, 0, 0, ...le24(9), ...le24(199)];
      const riff = (...chunks: number[][]) => bytes(text('RIFF'), [0, 0, 0, 0], text('WEBP'), ...chunks);
      const exifChunk = (data: number[]) => [...text('EXIF'), ...[data.length & 255, 0, 0, 0], ...data, ...(data.length & 1 ? [0] : [])];
      expect(imageDimensions(riff(vp8x(0x08), coded(10, 200), exifChunk(tiff(6))), 'image/webp')).toEqual({ width: 200, height: 10 });
      expect(imageDimensions(riff(vp8x(0x08), coded(10, 200), exifChunk([...text('Exif'), 0, 0, ...tiff(8)])), 'image/webp')).toEqual({ width: 200, height: 10 });
      expect(imageDimensions(riff(vp8x(0), coded(10, 200), exifChunk(tiff(6))), 'image/webp')).toEqual({ width: 10, height: 200 }); // no flag: no EXIF
      expect(imageDimensions(riff(vp8x(0x08), coded(10, 200)), 'image/webp')).toBeUndefined();
      expect(imageDimensions(riff(vp8x(0x08), coded(10, 200), exifChunk([1, 2, 3])), 'image/webp')).toBeUndefined();
    });
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

    it('an EXIF directory that points outside the segment is undefined — the turn it may hold is unknown', () => {
      const wild = exif(6, 'II');
      wild.splice(10 + 4, 4, 0xff, 0xff, 0xff, 0x7f); // the offset of the first directory
      expect(imageDimensions(jpeg(800, 600, [wild]), 'image/jpeg')).toBeUndefined();
    });

    it('an EXIF directory of 65 535 entries stops at the segment, and is undefined', () => {
      const many = exif(6, 'MM');
      many.splice(18, 4, 0xff, 0xff, 0x01, 0x10); // the count, then a tag that is not the orientation
      expect(imageDimensions(jpeg(800, 600, [many]), 'image/jpeg')).toBeUndefined();
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

    it('a 64-bit AVIF box size is refused for its high word alone — the low word is the true length', () => {
      const file = avif(400, 300);
      const ftyp = new DataView(file.buffer).getUint32(0);
      const body = [...file.subarray(ftyp + 8)]; // what the 32-bit `meta` box holds
      const meta = (high: number) => bytes(file.subarray(0, ftyp), [0, 0, 0, 1], text('meta'), be32(high), be32(16 + body.length), body);
      expect(imageDimensions(meta(0), 'image/avif')).toEqual({ width: 400, height: 300 });
      expect(imageDimensions(meta(1), 'image/avif')).toBeUndefined();
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
