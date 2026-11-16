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
const u32le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
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

/** Whether `b` is a whole file — fewer bytes than were asked for — so that nothing lies beyond what was read. */
const whole = (b: Uint8Array) => b.length < DIMENSION_BYTES;

/**
 * A PNG's size, turned by the orientation of an `eXIf` chunk before the first `IDAT` (the place decoders read metadata from). The
 * chunks are walked within the bytes given; an `eXIf` that cannot be read, or a walk that ends before `IDAT` with more of the file
 * unread, is `undefined`.
 */
function png(b: Uint8Array): ImageDimensions | undefined {
  if (b.length < 24 || !ascii(b, 1, 'PNG') || !ascii(b, 12, 'IHDR')) return undefined;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  let orientation: number | undefined;
  let at = 33; // the signature, then IHDR: length, type, 13 bytes of data and the checksum
  for (let step = 0; step < MAX_STEPS; step++) {
    if (at >= b.length) return whole(b) ? size(width, height, (orientation ?? 1) >= 5) : undefined;
    if (at + 8 > b.length) return undefined;
    const length = u32be(b, at);
    const type = String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!);
    if (type === 'IDAT') return size(width, height, (orientation ?? 1) >= 5);
    if (at + 12 + length > b.length) return undefined; // a chunk that does not fit may hide an eXIf behind it
    if (type === 'eXIf') {
      if (orientation !== undefined || at + 8 + length > b.length) return undefined;
      orientation = exifOrientation(b, at + 8, at + 8 + length);
      if (orientation === undefined) return undefined;
    }
    at += 12 + length;
  }
  return undefined;
}

/**
 * A GIF's size for a limit: the larger of the logical screen and the right and bottom edge of every frame, on each side — a browser
 * keeps the screen, but a decoder that reads all frames allocates each. The blocks are walked up to the trailer, and each step
 * moves on at least one byte, so the walk is bounded by the bytes given. A file whose trailer is not within them is `undefined`:
 * a later frame cannot be checked.
 */
function gif(b: Uint8Array): ImageDimensions | undefined {
  if (b.length < 13 || !(ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return undefined;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  let at = 13 + ((b[10]! & 0x80) !== 0 ? 3 * 2 ** ((b[10]! & 7) + 1) : 0);
  const skipSubBlocks = () => {
    while (at < b.length && b[at] !== 0) at += b[at]! + 1;
    at++; // the zero-length block that ends them
  };
  while (at < b.length) {
    const kind = b[at]!;
    if (kind === 0x3b) return size(width, height);
    if (kind === 0x2c) {
      if (at + 10 > b.length) return undefined;
      width = Math.max(width, u16le(b, at + 1) + u16le(b, at + 5));
      height = Math.max(height, u16le(b, at + 3) + u16le(b, at + 7));
      const packed = b[at + 9]!;
      at += 10 + ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1; // the descriptor, its colour table, the code size byte
      skipSubBlocks();
    } else if (kind === 0x21) {
      if (b[at + 1] === 0xf9 && b[at + 2] !== 4) return undefined; // a graphic control block is four bytes: anything else is damaged
      at += 2; // the introducer and the label, then data sub-blocks
      skipSubBlocks();
    } else {
      return undefined; // a byte no block starts with
    }
  }
  return undefined;
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
  if (ascii(b, 12, 'VP8X')) return webpExtended(b);
  return undefined;
}

/** The size of the coded image in a `VP8 ` or `VP8L` chunk whose header starts at `at`, or undefined when it is not all in `b`. */
function webpCoded(b: Uint8Array, at: number, lossless: boolean): ImageDimensions | undefined {
  const d = at + 8;
  if (lossless) return b.length < d + 5 || b[d] !== 0x2f ? undefined : size(1 + (b[d + 1]! | ((b[d + 2]! & 0x3f) << 8)), 1 + ((b[d + 2]! >> 6) | (b[d + 3]! << 2) | ((b[d + 4]! & 0x0f) << 10)));
  return b.length < d + 10 || b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a ? undefined : size(u16le(b, d + 6) & 0x3fff, u16le(b, d + 8) & 0x3fff);
}

/**
 * An extended WebP: the canvas its `VP8X` chunk states, and the coded image (or the first animation frame, offset included) in the
 * chunks after it — a decoder may use either, so the larger side of each counts. The orientation of an `EXIF` chunk, when the flags
 * name one, turns it. Everything is looked for within the bytes given; what is not found there makes the size `undefined`.
 */
function webpExtended(b: Uint8Array): ImageDimensions | undefined {
  if (b.length < 30) return undefined;
  const flags = b[20]!;
  let canvas = size(1 + u24le(b, 24), 1 + u24le(b, 27));
  let coded: ImageDimensions | undefined;
  let frame: ImageDimensions | undefined;
  let orientation: number | undefined = (flags & 0x08) === 0 ? 1 : undefined;
  let at = 12;
  for (let step = 0; step < MAX_STEPS && at + 8 <= b.length; step++) {
    const length = u32le(b, at + 4);
    if (!coded && (ascii(b, at, 'VP8 ') || ascii(b, at, 'VP8L'))) {
      coded = webpCoded(b, at, b[at + 3] === 0x4c);
      if (!coded) return undefined;
    } else if (!frame && ascii(b, at, 'ANMF')) {
      if (at + 8 + 12 > b.length) return undefined;
      const [x, y, w, h] = [u24le(b, at + 8) * 2, u24le(b, at + 11) * 2, 1 + u24le(b, at + 14), 1 + u24le(b, at + 17)];
      frame = size(x + w, y + h);
      if (!frame) return undefined;
    } else if (ascii(b, at, 'EXIF') && (flags & 0x08) !== 0 && orientation === undefined) {
      if (at + 8 + length > b.length) return undefined;
      orientation = exifOrientation(b, at + 8 + (ascii(b, at + 8, 'Exif\0\0') ? 6 : 0), at + 8 + length);
      if (orientation === undefined) return undefined;
    }
    at += 8 + length + (length & 1);
  }
  if (!canvas || orientation === undefined || (flags & 0x02 ? !frame : !coded && !frame)) return undefined;
  for (const found of [coded, frame]) {
    if (found) canvas = size(Math.max(canvas!.width, found.width), Math.max(canvas!.height, found.height));
  }
  return canvas && size(canvas.width, canvas.height, orientation >= 5);
}

/**
 * The orientation (1–8) the first directory of the TIFF structure in `b[start, end)` names, 1 when it names none; `undefined` when the
 * structure cannot be read (a header, a directory or an entry out of bounds, a value that is no orientation).
 */
function exifOrientation(b: Uint8Array, start: number, end: number): number | undefined {
  if (end - start < 8) return undefined;
  const little = ascii(b, start, 'II');
  if (!little && !ascii(b, start, 'MM')) return undefined;
  const u16 = (at: number) => (little ? u16le(b, at) : u16be(b, at));
  const u32 = (at: number) => (little ? (u16le(b, at) | (u16le(b, at + 2) << 16)) >>> 0 : u32be(b, at));
  if (u16(start + 2) !== 42) return undefined;
  const directory = start + u32(start + 4);
  if (directory + 2 > end) return undefined;
  const entries = u16(directory);
  for (let i = 0; i < Math.min(entries, 256); i++) {
    const at = directory + 2 + i * 12;
    if (at + 12 > end) return undefined;
    if (u16(at) === 0x0112) {
      // Only a SHORT with count 1 is an orientation to a decoder; the same tag with another type or count turns nothing, and is not trusted.
      if (u16(at + 2) !== 3 || u32(at + 4) !== 1) return undefined;
      const value = u16(at + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return entries > 256 ? undefined : 1; // an unread entry may be the orientation
}

/**
 * A JPEG's size from its first frame header, turned by the orientation of its Exif segment (before or after the frame). The
 * segments are walked up to the start of the scan, which must lie within the bytes given; a second Exif segment, one that cannot be read, or a
 * walk that ends earlier is `undefined`.
 */
function jpeg(b: Uint8Array): ImageDimensions | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let orientation: number | undefined;
  let frame: { width: number; height: number } | undefined;
  let at = 2;
  for (let step = 0; step < MAX_STEPS; step++) {
    while (b[at] === 0xff && b[at + 1] === 0xff) at++; // fill bytes
    if (at + 4 > b.length || b[at] !== 0xff) return undefined;
    const marker = b[at + 1]!;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // no length
      continue;
    }
    if (marker === 0xd9) return undefined;
    if (marker === 0xda) return frame ? size(frame.width, frame.height, (orientation ?? 1) >= 5) : undefined;
    const length = u16be(b, at + 2);
    if (length < 2) return undefined;
    const end = at + 2 + length;
    if (end > b.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (frame || length < 7) return undefined;
      frame = { width: u16be(b, at + 7), height: u16be(b, at + 5) };
    } else if (marker === 0xe1 && ascii(b, at + 4, 'Exif\0\0')) {
      if (orientation !== undefined) return undefined;
      orientation = exifOrientation(b, at + 10, end);
      if (orientation === undefined) return undefined;
    }
    at = end;
  }
  return undefined;
}

interface IsoBox {
  readonly type: string;
  /** Where the box's content starts, and where it ends (cut to its parent and to the bytes given). */
  readonly body: number;
  readonly end: number;
  /** Whether the box states an end beyond the bytes it was read from, so what lies in it is only partly seen. */
  readonly cut: boolean;
}

/**
 * The boxes in `b[from, to)`, in order. `complete` is false when the list stops before `to` — {@link MAX_STEPS} boxes were
 * visited, or a box is shorter than its header or states a 64-bit size beyond 4 GiB — so a box that is not in the list may still exist.
 */
function isoBoxes(b: Uint8Array, from: number, to: number): { readonly boxes: IsoBox[]; readonly complete: boolean } {
  const boxes: IsoBox[] = [];
  let at = from;
  while (at + 8 <= to) {
    if (boxes.length >= MAX_STEPS) return { boxes, complete: false };
    let length = u32be(b, at);
    let header = 8;
    if (length === 1) {
      if (at + 16 > to || u32be(b, at + 8) !== 0) return { boxes, complete: false };
      length = u32be(b, at + 12);
      header = 16;
    } else if (length === 0) {
      length = to - at;
    }
    if (length < header) return { boxes, complete: false };
    boxes.push({ type: String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!), body: at + header, end: Math.min(at + length, to), cut: at + length > to });
    at += length;
  }
  return { boxes, complete: true };
}

/** The whole, uncut children of the box at `[from, to)`, or undefined when the list is not complete or the one wanted is cut. */
function children(b: Uint8Array, from: number, to: number, ...types: string[]): (IsoBox | undefined)[] | undefined {
  const { boxes, complete } = isoBoxes(b, from, to);
  if (!complete) return undefined;
  const found = types.map((type) => boxes.find((box) => box.type === type));
  return found.some((box) => box?.cut) ? undefined : found;
}

/**
 * The size of the primary image of an AVIF: `pitm` names the item, `ipma` the properties of `ipco` it has (a 1-based index),
 * and of those `ispe` is the size and `irot` a quarter turn. The first `ispe` in the file may belong to a tile or a thumbnail.
 * Every box on the way must be whole and every list complete, or the size is `undefined`: what is not seen may say otherwise.
 */
function avifPrimary(b: Uint8Array, top: readonly IsoBox[]): ImageDimensions | undefined {
  const meta = top.find((box) => box.type === 'meta');
  if (!meta || meta.cut || meta.body + 4 > meta.end) return undefined;
  const [pitm, iprp] = children(b, meta.body + 4, meta.end, 'pitm', 'iprp') ?? []; // a full box: four bytes of version and flags
  if (!pitm || !iprp) return undefined;
  const idSize = b[pitm.body] === 0 ? 2 : 4; // version 0: a 16-bit item id
  if (pitm.body + 4 + idSize > pitm.end) return undefined;
  const primary = idSize === 2 ? u16be(b, pitm.body + 4) : u32be(b, pitm.body + 4);

  const [ipco, ipma] = children(b, iprp.body, iprp.end, 'ipco', 'ipma') ?? [];
  if (!ipco || !ipma || ipma.body + 8 > ipma.end) return undefined;
  const listed = isoBoxes(b, ipco.body, ipco.end);
  if (!listed.complete) return undefined;
  const properties = listed.boxes;

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
    if (index === 0) continue; // 0 names no property
    const property = properties[index - 1];
    if (!property || property.cut) return undefined; // an index past the list: a property that was not seen may be the size
    if (property.type === 'ispe' && !found && property.body + 12 <= property.end) found = { width: u32be(b, property.body + 4), height: u32be(b, property.body + 8) };
    else if (property.type === 'irot' && property.body < property.end) quarter = b[property.body]! & 3;
  }
  return found ? size(found.width, found.height, quarter === 1 || quarter === 3) : undefined;
}

/**
 * The size of an AVIF still image. An image sequence (brand `avis`, or a `moov` box) shows tracks whose size nothing here reads,
 * so it is `undefined`, as is a still image whose primary item cannot be followed through whole boxes and complete lists.
 */
function avif(b: Uint8Array): ImageDimensions | undefined {
  const { boxes: top, complete } = isoBoxes(b, 0, b.length);
  if (!complete) return undefined;
  if (top.some((box) => box.type === 'moov')) return undefined;
  const ftyp = top.find((box) => box.type === 'ftyp');
  if (ftyp) {
    for (let at = ftyp.body; at + 4 <= ftyp.end; at += at === ftyp.body ? 8 : 4) if (ascii(b, at, 'avis')) return undefined; // the major brand, then the compatible ones
  }
  return avifPrimary(b, top);
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
