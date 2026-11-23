import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ByteRange, OpenedFile } from './disk.ts';
import { StorageError } from './errors.ts';
import { checkRange, confirmedRange, resolveRange } from './ranges.ts';

describe('resolveRange', () => {
  const cases: readonly (readonly [string, ByteRange, number, unknown])[] = [
    ['from a start, no end', { start: 2 }, 10, { start: 2, end: 9 }],
    ['from a start to an end', { start: 2, end: 4 }, 10, { start: 2, end: 4 }],
    ['one byte', { start: 0, end: 0 }, 1, { start: 0, end: 0 }],
    ['the end cut to the file', { start: 2, end: 99 }, 10, { start: 2, end: 9 }],
    ['a huge end cut to the file', { start: 0, end: Number.MAX_SAFE_INTEGER }, 1000, { start: 0, end: 999 }],
    ['the last bytes', { last: 3 }, 10, { start: 7, end: 9 }],
    ['more last bytes than the file has', { last: 99 }, 10, { start: 0, end: 9 }],
    ['a huge suffix', { last: Number.MAX_SAFE_INTEGER }, 1000, { start: 0, end: 999 }],
    ['a start at the size', { start: 10 }, 10, 'unsatisfiable'],
    ['a start past the size', { start: 11, end: 20 }, 10, 'unsatisfiable'],
    ['the last 0 bytes', { last: 0 }, 10, 'unsatisfiable'],
    ['a start in an empty file', { start: 0 }, 0, 'unsatisfiable'],
    ['a suffix of an empty file: the whole, empty file', { last: 5 }, 0, undefined],
    ['the last 0 bytes of an empty file', { last: 0 }, 0, 'unsatisfiable'],
    ['a start of 0 in a file of 1', { start: 0 }, 1, { start: 0, end: 0 }],
    ['a start at the size of a file of 1', { start: 1 }, 1, 'unsatisfiable'],
    ['the last byte of a file of 1', { last: 1 }, 1, { start: 0, end: 0 }],
  ];
  it.each(cases)('%s', (_name, range, size, expected) => {
    expect(resolveRange(range, size)).toEqual(expected);
  });
});

describe('checkRange', () => {
  it('copies a good range, so a later change to the caller\'s object does not reach the disk', () => {
    const range = { start: 1, end: 2 };
    const checked = checkRange(range);
    range.end = 99;
    expect(checked).toEqual({ start: 1, end: 2 });
    expect(checkRange({ start: 0 })).toEqual({ start: 0 });
    expect(checkRange({ last: 0 })).toEqual({ last: 0 });
  });

  it('negative: anything but a whole range is a RangeError', () => {
    const bad: unknown[] = [
      { start: -1 }, { start: 1.5 }, { start: Number.NaN }, { start: Number.POSITIVE_INFINITY }, { start: Number.MAX_SAFE_INTEGER + 1 },
      { start: '1' }, { start: 1n }, { start: 3, end: 2 }, { start: 0, end: -1 }, { start: 0, end: 1.5 }, { start: 0, end: Number.NaN },
      { last: -1 }, { last: 1.5 }, { last: Number.NaN }, { last: '2' },
      { start: 0, last: 1 }, { end: 3, last: 1 }, { last: 1, start: undefined, end: 0 },
      {}, { end: 3 }, null, undefined, 3, 'bytes=0-1', [],
    ];
    for (const range of bad) expect(() => checkRange(range as ByteRange), inspect(range)).toThrow(RangeError);
  });
});

describe('confirmedRange', () => {
  const opened = (extra: Partial<OpenedFile> = {}) => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ cancel: () => void cancelled++ });
    return { file: { body, size: 10, lastModified: new Date(0), contentType: 'text/plain', ...extra } satisfies OpenedFile, cancelled: () => cancelled };
  };

  it('a file with no range is the whole file: it passes with the body untouched and acceptsRanges set', async () => {
    const { file, cancelled } = opened();
    const kept = await confirmedRange({ start: 2 }, file);
    expect([kept.body, kept.size, kept.range, kept.acceptsRanges]).toEqual([file.body, 10, undefined, true]);
    expect(cancelled()).toBe(0);
  });

  it('the range the request resolves to, and unsatisfiable for an unsatisfiable one, pass', async () => {
    const a = opened({ range: { start: 7, end: 9 } });
    const kept = await confirmedRange({ last: 3 }, a.file);
    expect([kept.range, kept.size, kept.body]).toEqual([{ start: 7, end: 9 }, 10, a.file.body]);
    const b = opened({ range: 'unsatisfiable' });
    const none = await confirmedRange({ start: 10 }, b.file);
    expect([none.range, b.cancelled(), (await new Response(none.body).arrayBuffer()).byteLength]).toEqual(['unsatisfiable', 1, 0]);
  });

  it('negative: another range, unsatisfiable for a satisfiable one or a range for an unsatisfiable one — body cancelled, StorageError', async () => {
    const wrong: readonly [ByteRange, Partial<OpenedFile>][] = [
      [{ start: 2, end: 4 }, { range: { start: 2, end: 5 } }],
      [{ start: 2, end: 4 }, { range: { start: 3, end: 4 } }],
      [{ start: 2 }, { range: { start: 2, end: 8 } }],
      [{ start: 2, end: 4 }, { range: 'unsatisfiable' }],
      [{ start: 10 }, { range: { start: 0, end: 9 } }],
      [{ last: 3 }, { range: { start: 0, end: 9 } }],
      [{ last: 5 }, { size: 0, range: { start: 0, end: 0 } }],
      [{ start: 2 }, { size: Number.NaN, range: { start: 2, end: 9 } }],
      [{ start: 2 }, { size: Number.POSITIVE_INFINITY, range: { start: 2, end: Number.POSITIVE_INFINITY } }],
      [{ start: 2 }, { size: -1, range: { start: 2, end: 9 } }],
      [{ start: 2 }, { size: 1.5, range: { start: 2, end: 9 } }],
      [{ start: 2 }, { range: 'bytes 2-9/10' as never }],
    ];
    for (const [requested, extra] of wrong) {
      const { file, cancelled } = opened(extra);
      await expect(confirmedRange(requested, file), JSON.stringify([requested, extra])).rejects.toThrow(StorageError);
      expect(cancelled()).toBe(1);
    }
  });
});
