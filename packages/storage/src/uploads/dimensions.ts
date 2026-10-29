/**
 * The width and height of an image by its first bytes — no decoder, no pixels. Reads headers only, and every loop is bounded
 * (a segment or box moves at least two bytes on and at most {@link MAX_STEPS} are visited), so a damaged or hostile file ends in
 * `undefined`, never in a hang. See `docs/images.md#images-from-the-server`.
 */

/** How many bytes of a file {@link imageDimensions} needs to be given: enough for the headers of every format, JPEG's EXIF included. */
export const DIMENSION_BYTES = 256 * 1024;

/** The most JPEG segments or AVIF boxes one file may take to reach its size. */
const MAX_STEPS = 1024;

/** The largest side a format can hold (PNG: 2^31 − 1); anything beyond is a damaged header. */
const MAX_SIDE = 0x7fffffff;

/** An image's size in pixels, as a browser shows it (EXIF orientation and AVIF rotation applied). */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

const ascii = (b: Uint8Array, at: number, text: string) => {
  if (b.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

function size(width: number, height: number, swap = false): ImageDimensions | undefined {
  if (!(width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE)) return undefined;
  return swap ? { width: height, height: width } : { width, height };
}

function png(b: Uint8Array): ImageDimensions | undefined {
  if (b.length < 24 || !ascii(b, 1, 'PNG') || !ascii(b, 12, 'IHDR')) return undefined;
  return size(u32be(b, 16), u32be(b, 20));
}

function gif(b: Uint8Array): ImageDimensions | undefined {
  if (b.length < 10 || !(ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return undefined;
  return size(u16le(b, 6), u16le(b, 8));
}

function webp(b: Uint8Array): ImageDimensions | undefined {
  if (!ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return undefined;
  if (ascii(b, 12, 'VP8 ')) {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b.length < 25 || b[20] !== 0x2f) return undefined;
    return size(1 + (b[21]! | ((b[22]! & 0x3f) << 8)), 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10)));
  }
  if (ascii(b, 12, 'VP8X')) {
    if (b.length < 30) return undefined;
    return size(1 + u24le(b, 24), 1 + u24le(b, 27));
  }
  return undefined;
}

/** The orientation (1–8) the first directory of the TIFF structure in `b[start, end)` names; 1 when absent or out of bounds. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (end - start < 8) return 1;
  const little = ascii(b, start, 'II');
  if (!little && !ascii(b, start, 'MM')) return 1;
  const u16 = (at: number) => (little ? u16le(b, at) : u16be(b, at));
  const u32 = (at: number) => (little ? (u16le(b, at) | (u16le(b, at + 2) << 16)) >>> 0 : u32be(b, at));
  const directory = start + u32(start + 4);
  if (directory + 2 > end) return 1;
  const entries = Math.min(u16(directory), 256);
  for (let i = 0; i < entries; i++) {
    const at = directory + 2 + i * 12;
    if (at + 12 > end) return 1;
    if (u16(at) === 0x0112) {
      const value = u16(at + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpeg(b: Uint8Array): ImageDimensions | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let orientation = 1;
  let at = 2;
  for (let step = 0; step < MAX_STEPS; step++) {
    while (b[at] === 0xff && b[at + 1] === 0xff) at++; // fill bytes
    if (at + 4 > b.length || b[at] !== 0xff) return undefined;
    const marker = b[at + 1]!;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // the image data begins without a frame header
    const length = u16be(b, at + 2);
    if (length < 2) return undefined;
    const end = at + 2 + length;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (end > b.length || length < 7) return undefined;
      return size(u16be(b, at + 7), u16be(b, at + 5), orientation >= 5);
    }
    if (marker === 0xe1 && ascii(b, at + 4, 'Exif\0\0')) orientation = exifOrientation(b, at + 10, Math.min(end, b.length));
    if (end >= b.length) return undefined;
    at = end;
  }
  return undefined;
}

interface IsoBox {
  readonly type: string;
  /** Where the box's content starts, and where it ends (cut to its parent and to the bytes given). */
  readonly body: number;
  readonly end: number;
}

/** The boxes in `b[from, to)`, in order — at most {@link MAX_STEPS}; a box shorter than its header, or a 64-bit size beyond 4 GiB, ends the list. */
function isoBoxes(b: Uint8Array, from: number, to: number): IsoBox[] {
  const boxes: IsoBox[] = [];
  let at = from;
  while (at + 8 <= to && boxes.length < MAX_STEPS) {
    let length = u32be(b, at);
    let header = 8;
    if (length === 1) {
      if (at + 16 > to || u32be(b, at + 8) !== 0) break;
      length = u32be(b, at + 12);
      header = 16;
    } else if (length === 0) {
      length = to - at;
    }
    if (length < header) break;
    boxes.push({ type: String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!), body: at + header, end: Math.min(at + length, to) });
    at += length;
  }
  return boxes;
}

/**
 * The size of the primary image of an AVIF: `pitm` names the item, `ipma` the properties of `ipco` it has (a 1-based index),
 * and of those `ispe` is the size and `irot` a quarter turn. The first `ispe` in the file may belong to a tile or a thumbnail.
 */
function avif(b: Uint8Array): ImageDimensions | undefined {
  const meta = isoBoxes(b, 0, b.length).find((box) => box.type === 'meta');
  if (!meta || meta.body + 4 > meta.end) return undefined;
  const inMeta = isoBoxes(b, meta.body + 4, meta.end); // a full box: four bytes of version and flags
  const pitm = inMeta.find((box) => box.type === 'pitm');
  const iprp = inMeta.find((box) => box.type === 'iprp');
  if (!pitm || !iprp) return undefined;
  const idSize = b[pitm.body] === 0 ? 2 : 4; // version 0: a 16-bit item id
  if (pitm.body + 4 + idSize > pitm.end) return undefined;
  const primary = idSize === 2 ? u16be(b, pitm.body + 4) : u32be(b, pitm.body + 4);

  const inProps = isoBoxes(b, iprp.body, iprp.end);
  const ipco = inProps.find((box) => box.type === 'ipco');
  const ipma = inProps.find((box) => box.type === 'ipma');
  if (!ipco || !ipma || ipma.body + 8 > ipma.end) return undefined;
  const properties = isoBoxes(b, ipco.body, ipco.end);

  const itemSize = b[ipma.body]! < 1 ? 2 : 4;
  const wide = (b[ipma.body + 3]! & 1) === 1; // 15-bit property indexes instead of 7-bit
  const step = wide ? 2 : 1;
  const entries = Math.min(u32be(b, ipma.body + 4), MAX_STEPS * 16);
  let at = ipma.body + 8;
  let indexes: number[] | undefined;
  for (let entry = 0; entry < entries && !indexes; entry++) {
    if (at + itemSize + 1 > ipma.end) return undefined;
    const item = itemSize === 2 ? u16be(b, at) : u32be(b, at);
    const count = b[at + itemSize]!;
    at += itemSize + 1;
    if (at + count * step > ipma.end) return undefined;
    if (item === primary) {
      indexes = [];
      for (let i = 0; i < count; i++) indexes.push(wide ? u16be(b, at + i * 2) & 0x7fff : b[at + i]! & 0x7f);
    }
    at += count * step;
  }
  if (!indexes) return undefined;

  let found: { width: number; height: number } | undefined;
  let quarter = 0;
  for (const index of indexes) {
    const property = properties[index - 1];
    if (!property) continue;
    if (property.type === 'ispe' && !found && property.body + 12 <= property.end) found = { width: u32be(b, property.body + 4), height: u32be(b, property.body + 8) };
    else if (property.type === 'irot' && property.body < property.end) quarter = b[property.body]! & 3;
  }
  return found ? size(found.width, found.height, quarter === 1 || quarter === 3) : undefined;
}

/**
 * The size of an image of `mime` (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`) from its first bytes
 * ({@link DIMENSION_BYTES} are enough), turned the way a browser shows it; `undefined` for another type, a cut-off or a damaged header.
 */
export function imageDimensions(bytes: Uint8Array, mime: string): ImageDimensions | undefined {
  switch (mime) {
    case 'image/png':
      return png(bytes);
    case 'image/jpeg':
      return jpeg(bytes);
    case 'image/gif':
      return gif(bytes);
    case 'image/webp':
      return webp(bytes);
    case 'image/avif':
      return avif(bytes);
    default:
      return undefined;
  }
}
