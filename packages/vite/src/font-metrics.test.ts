import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFontMetrics } from './font-metrics.ts';
import { ttf, woff, woff2, type FixtureMetrics } from './__fixtures__/fonts.ts';

const metrics: FixtureMetrics = { unitsPerEm: 1000, ascender: 1025, descender: -275, lineGap: 12, xAvgCharWidth: 533 };

describe('readFontMetrics', () => {
  it('reads the same values from TrueType, WOFF and WOFF2', () => {
    for (const bytes of [ttf(metrics), woff(metrics), woff2(metrics)]) expect(readFontMetrics(bytes)).toEqual(metrics);
  });

  it('reads a real WOFF2 file, whose glyph tables are transformed', () => {
    const bytes = readFileSync(join(dirname(createRequire(import.meta.url).resolve('@fontsource-variable/ibm-plex-sans/package.json')), 'files/ibm-plex-sans-latin-wght-normal.woff2'));
    expect(readFontMetrics(bytes)).toEqual({ unitsPerEm: 1000, ascender: 1025, descender: -275, lineGap: 0, xAvgCharWidth: 533 });
  });

  it('refuses a file that is no font, a collection, a cut-off file and one without a table', () => {
    expect(() => readFontMetrics(Buffer.from('<!doctype html>'))).toThrow(/not a TrueType, OpenType, WOFF or WOFF2 font/);
    expect(() => readFontMetrics(Buffer.alloc(0))).toThrow(/not a TrueType/);
    expect(() => readFontMetrics(Buffer.concat([Buffer.from('ttcf'), Buffer.alloc(60)]))).toThrow(/collection/);
    for (const make of [ttf, woff, woff2]) {
      const bytes = make(metrics);
      expect(() => readFontMetrics(bytes.subarray(0, bytes.length - 40)), make.name).toThrow(Error);
      expect(() => readFontMetrics(bytes.subarray(0, 20)), make.name).toThrow(Error);
    }
    // The directory names the tables; with the `OS/2` one renamed there is none.
    const renamed = ttf(metrics);
    renamed.write('XXXX', 12, 'latin1');
    expect(() => readFontMetrics(renamed)).toThrow(/no `OS\/2` table/);
  });

  it('refuses a small file that declares a huge table, before it allocates anything', () => {
    const small = woff(metrics);
    // The `OS/2` entry of the WOFF: stored length, then the declared original length.
    small.writeUInt32BE(1024 * 1024 * 1024, 44 + 12);
    expect(() => readFontMetrics(small)).toThrow(/declares 1073741824 bytes/);
    const stream = woff2(metrics);
    // The first directory entry is `OS/2` (flag byte, then its length as a base-128 number): declare 2^28 bytes.
    const huge = Buffer.concat([stream.subarray(0, 48), Buffer.from([6, 0x81, 0x80, 0x80, 0x80, 0x00]), stream.subarray(48 + 3)]);
    expect(() => readFontMetrics(huge)).toThrow(/more than the 67108864/);
  });

  it('refuses damaged compressed data and empty metrics', () => {
    const damaged = woff2(metrics);
    damaged.fill(0xff, damaged.length - 20);
    expect(() => readFontMetrics(damaged)).toThrow(/damaged/);
    expect(() => readFontMetrics(ttf({ ...metrics, unitsPerEm: 0 }))).toThrow(/metrics are empty/);
  });
});
