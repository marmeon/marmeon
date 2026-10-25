import { brotliCompressSync, deflateSync } from 'node:zlib';

/** The metrics a fixture font carries. */
export interface FixtureMetrics {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineGap: number;
  xAvgCharWidth: number;
}

type Table = { tag: string; data: Buffer };

/** `head`, `hhea` and `OS/2` with only the fields the reader looks at; a `glyf` stands in for the table WOFF2 transforms. */
function tables({ unitsPerEm, ascender, descender, lineGap, xAvgCharWidth }: FixtureMetrics): Table[] {
  const head = Buffer.alloc(54);
  head.writeUInt16BE(unitsPerEm, 18);
  const hhea = Buffer.alloc(36);
  hhea.writeInt16BE(ascender, 4);
  hhea.writeInt16BE(descender, 6);
  hhea.writeInt16BE(lineGap, 8);
  const os2 = Buffer.alloc(96);
  os2.writeInt16BE(xAvgCharWidth, 2);
  return [
    { tag: 'OS/2', data: os2 },
    { tag: 'glyf', data: Buffer.alloc(300, 7) },
    { tag: 'head', data: head },
    { tag: 'hhea', data: hhea },
  ];
}

/** A TrueType file (version 0x00010000) with the tables. */
export function ttf(metrics: FixtureMetrics): Buffer {
  const list = tables(metrics);
  const header = Buffer.alloc(12 + list.length * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(list.length, 4);
  let offset = header.length;
  const bodies: Buffer[] = [];
  list.forEach(({ tag, data }, index) => {
    header.write(tag, 12 + index * 16, 'latin1');
    header.writeUInt32BE(offset, 12 + index * 16 + 8);
    header.writeUInt32BE(data.length, 12 + index * 16 + 12);
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([header, ...bodies]);
}

/** A WOFF file: each table deflated, the `glyf` one left as it is (it does not shrink in a real font, here it would). */
export function woff(metrics: FixtureMetrics): Buffer {
  const list = tables(metrics);
  const header = Buffer.alloc(44 + list.length * 20);
  header.write('wOFF', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(list.length, 12);
  let offset = header.length;
  const bodies: Buffer[] = [];
  list.forEach(({ tag, data }, index) => {
    const stored = tag === 'glyf' ? data : deflateSync(data);
    const entry = 44 + index * 20;
    header.write(tag, entry, 'latin1');
    header.writeUInt32BE(offset, entry + 4);
    header.writeUInt32BE(stored.length, entry + 8);
    header.writeUInt32BE(data.length, entry + 12);
    const padded = Buffer.concat([stored, Buffer.alloc((4 - (stored.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([header, ...bodies]);
}

function base128(value: number): Buffer {
  const bytes = [value & 0x7f];
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest & 0x7f) | 0x80);
  return Buffer.from(bytes);
}

/**
 * A WOFF2 file: the directory with the known table numbers, the `glyf` table marked transformed (its stored length differs
 * from its original one, as in a real file), and one Brotli stream.
 */
export function woff2(metrics: FixtureMetrics): Buffer {
  const list = tables(metrics);
  const known: Record<string, number> = { head: 1, hhea: 2, 'OS/2': 6, glyf: 10 };
  const directory: Buffer[] = [];
  const stream: Buffer[] = [];
  for (const { tag, data } of list) {
    if (tag === 'glyf') {
      // Version 0 for `glyf` is "transformed": the stored bytes are shorter than the original table.
      directory.push(Buffer.from([known[tag]!]), base128(5000), base128(data.length));
    } else {
      directory.push(Buffer.from([known[tag]!]), base128(data.length));
    }
    stream.push(data);
  }
  const compressed = brotliCompressSync(Buffer.concat(stream));
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(list.length, 12);
  header.writeUInt32BE(compressed.length, 20);
  const body = Buffer.concat([header, ...directory, compressed]);
  body.writeUInt32BE(body.length, 8);
  return body;
}
