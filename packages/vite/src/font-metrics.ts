import { brotliDecompressSync, inflateSync } from 'node:zlib';

/** The numbers of a font file that decide how much room its text takes, in the font's own units. */
export interface FontMetrics {
  /** `head.unitsPerEm`. */
  readonly unitsPerEm: number;
  /** `hhea.ascender`. */
  readonly ascender: number;
  /** `hhea.descender`, negative below the baseline. */
  readonly descender: number;
  /** `hhea.lineGap`. */
  readonly lineGap: number;
  /** `OS/2.xAvgCharWidth`. */
  readonly xAvgCharWidth: number;
}

/** WOFF2's table directory names the common tables by a number (the specification's "known table tags"). */
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

/** No table the reader needs comes near this size; a header that declares more is a decompression bomb, not a font. */
const MAX_TABLE_BYTES = 1024 * 1024;

/** The WOFF2 stream holds every table, glyphs included: a real font is a few MiB, so more than this is refused before decompressing. */
const MAX_WOFF2_BYTES = 64 * 1024 * 1024;

/** The tables the reader looks at: WOFF decompresses nothing else. */
const NEEDED = new Set(['head', 'hhea', 'OS/2']);

/** A font file that is cut off or inconsistent: the caller adds the file's name. */
class FontFormatError extends Error {}

function fail(message: string): never {
  throw new FontFormatError(message);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tagAt(data: DataView, offset: number): string {
  return String.fromCharCode(data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3));
}

/** The bytes of each table, by tag. */
type Tables = Map<string, Uint8Array>;

function slice(bytes: Uint8Array, offset: number, length: number, what: string): Uint8Array {
  if (offset < 0 || length < 0 || offset + length > bytes.length) fail(`the ${what} lies outside the file`);
  return bytes.subarray(offset, offset + length);
}

function sfntTables(bytes: Uint8Array): Tables {
  const data = view(bytes);
  if (bytes.length < 12) fail('the file is too short for a font header');
  const tables: Tables = new Map();
  const count = data.getUint16(4);
  for (let index = 0; index < count; index++) {
    const entry = 12 + index * 16;
    if (entry + 16 > bytes.length) fail('the table directory is cut off');
    tables.set(tagAt(data, entry), slice(bytes, data.getUint32(entry + 8), data.getUint32(entry + 12), 'table'));
  }
  return tables;
}

function woffTables(bytes: Uint8Array): Tables {
  const data = view(bytes);
  if (bytes.length < 44) fail('the file is too short for a WOFF header');
  const tables: Tables = new Map();
  const count = data.getUint16(12);
  for (let index = 0; index < count; index++) {
    const entry = 44 + index * 20;
    if (entry + 20 > bytes.length) fail('the table directory is cut off');
    const tag = tagAt(data, entry);
    if (!NEEDED.has(tag)) continue;
    const stored = slice(bytes, data.getUint32(entry + 4), data.getUint32(entry + 8), 'table');
    const length = data.getUint32(entry + 12);
    if (length > MAX_TABLE_BYTES) fail(`its \`${tag}\` table declares ${length} bytes`);
    // A table that did not shrink is stored as it is.
    tables.set(tag, stored.length < length ? inflateSync(stored, { maxOutputLength: Math.max(length, 1) }) : stored);
  }
  return tables;
}

function woff2Tables(bytes: Uint8Array): Tables {
  const data = view(bytes);
  if (bytes.length < 48) fail('the file is too short for a WOFF2 header');
  if (tagAt(data, 4) === 'ttcf') fail('a font collection is not supported');
  const count = data.getUint16(12);
  const compressed = data.getUint32(20);
  let position = 48;
  const base128 = (): number => {
    let value = 0;
    for (let step = 0; step < 5; step++) {
      if (position >= bytes.length) fail('the table directory is cut off');
      const byte = data.getUint8(position++);
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    return fail('a number in the table directory is too long');
  };
  const directory: { tag: string; length: number }[] = [];
  for (let index = 0; index < count; index++) {
    if (position >= bytes.length) fail('the table directory is cut off');
    const flags = data.getUint8(position++);
    const known = flags & 0x3f;
    let tag: string;
    if (known === 0x3f) {
      if (position + 4 > bytes.length) fail('the table directory is cut off');
      tag = tagAt(data, position);
      position += 4;
    } else {
      tag = WOFF2_TAGS[known] ?? fail(`the table directory names the unknown table number ${known}`);
    }
    const original = base128();
    // The version in the top two bits: for `glyf` and `loca` 0 means transformed, for every other table 0 means as it is.
    const version = flags >> 6;
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    directory.push({ tag, length: transformed ? base128() : original });
  }
  const total = directory.reduce((sum, { length }) => sum + length, 0);
  if (total > MAX_WOFF2_BYTES) fail(`its tables declare ${total} bytes, more than the ${MAX_WOFF2_BYTES} a font may have`);
  const inflated = brotliDecompressSync(slice(bytes, position, compressed, 'compressed data'), { maxOutputLength: Math.max(total, 1) });
  const tables: Tables = new Map();
  let offset = 0;
  for (const { tag, length } of directory) {
    tables.set(tag, slice(inflated, offset, length, 'table'));
    offset += length;
  }
  return tables;
}

function need(tables: Tables, tag: string, length: number): DataView {
  const table = tables.get(tag);
  if (!table) return fail(`it has no \`${tag}\` table`);
  if (table.length < length) return fail(`its \`${tag}\` table is cut off`);
  return view(table);
}

/**
 * Reads the vertical metrics and the average width of a TrueType or OpenType font, a WOFF or a WOFF2 file, and nothing
 * else. Throws an `Error` that says what is wrong; the caller adds the file's name.
 */
export function readFontMetrics(bytes: Uint8Array): FontMetrics {
  try {
    const data = bytes.length >= 4 ? view(bytes) : undefined;
    const magic = data ? tagAt(data, 0) : '';
    const tables =
      magic === 'wOF2' ? woff2Tables(bytes)
      : magic === 'wOFF' ? woffTables(bytes)
      : magic === 'ttcf' ? fail('a font collection is not supported')
      : data && (data.getUint32(0) === 0x00010000 || magic === 'OTTO' || magic === 'true') ? sfntTables(bytes)
      : fail('it is not a TrueType, OpenType, WOFF or WOFF2 font');
    const head = need(tables, 'head', 20);
    const hhea = need(tables, 'hhea', 10);
    const os2 = need(tables, 'OS/2', 4);
    const metrics: FontMetrics = {
      unitsPerEm: head.getUint16(18),
      ascender: hhea.getInt16(4),
      descender: hhea.getInt16(6),
      lineGap: hhea.getInt16(8),
      xAvgCharWidth: os2.getInt16(2),
    };
    if (metrics.unitsPerEm === 0 || metrics.xAvgCharWidth <= 0) fail('its metrics are empty');
    return metrics;
  } catch (error) {
    if (error instanceof FontFormatError) throw error;
    // zlib and Brotli throw their own errors on damaged data.
    throw new FontFormatError(`the font data is damaged (${error instanceof Error ? error.message : String(error)})`);
  }
}
