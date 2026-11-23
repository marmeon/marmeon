import { Readable } from 'node:stream';
import { TestClock } from '@marmeon/core/testing';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DISK_KINDS, recordingUrls, removeDirectories } from './__fixtures__/disks.ts';
import type { Disk } from './disk.ts';
import { FileNotFoundError, InvalidKeyError, StorageError } from './errors.ts';

afterAll(removeDirectories);

const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

describe.each(DISK_KINDS.map((kind) => [kind.name, kind] as const))('the %s disk', (_name, kind) => {
  const clock = new TestClock();
  const opened: (Disk & { close?(): Promise<void> })[] = [];
  const make = async (visibility?: 'public' | 'private') => {
    const disk = await kind.make(clock, visibility);
    opened.push(disk);
    return disk;
  };
  afterEach(async () => {
    for (const disk of opened.splice(0)) await disk.close?.();
  });

  it.skipIf(kind.skip)('puts and reads text, bytes, Blobs and streams', async () => {
    const disk = await make();
    await disk.put('notes/a.txt', 'hello');
    await disk.put('bytes.bin', new Uint8Array([0, 1, 2, 255]));
    await disk.put('blob.json', new Blob(['{"a":1}']));
    await disk.put('node.txt', Readable.from([Buffer.from('from '), Buffer.from('node')]));
    await disk.put('web.txt', new Response('from the web').body!);
    expect(await disk.text('notes/a.txt')).toBe('hello');
    expect([...(await disk.get('bytes.bin'))]).toEqual([0, 1, 2, 255]);
    expect(await disk.text('blob.json')).toBe('{"a":1}');
    expect(await disk.text('node.txt')).toBe('from node');
    expect(await text(await disk.stream('web.txt'))).toBe('from the web');
    await disk.put('notes/a.txt', 'replaced');
    expect(await disk.text('notes/a.txt')).toBe('replaced');
  });

  it.skipIf(kind.skip)('knows size, type, time — and opens a file with all three', async () => {
    const disk = await make();
    clock.freeze();
    await disk.put('report.csv', 'a,b\n1,2\n');
    expect(await disk.size('report.csv')).toBe(8);
    expect(await disk.mimeType('report.csv')).toBe('text/csv');
    const modified = await disk.lastModified('report.csv');
    expect(Math.abs(modified.getTime() - Date.now())).toBeLessThan(60_000);
    const file = await disk.open('report.csv');
    expect([file.size, file.contentType]).toEqual([8, 'text/csv']);
    expect(await text(file.body)).toBe('a,b\n1,2\n');
  });

  it.skipIf(kind.skip || kind.name === 'local')('keeps the content type it was given', async () => {
    const disk = await make();
    await disk.put('blob', 'x', { contentType: 'image/webp' });
    expect(await disk.mimeType('blob')).toBe('image/webp');
  });

  describe.skipIf(kind.skip)('open() with a range', () => {
    const bytes = (file: { body: ReadableStream<Uint8Array> }) => text(file.body);

    it('opens the three forms with exactly their bytes, the whole size and acceptsRanges', async () => {
      const disk = await make();
      await disk.put('digits.txt', '0123456789');
      const from = await disk.open('digits.txt', { range: { start: 3 } });
      expect([await bytes(from), from.size, from.range, from.acceptsRanges]).toEqual(['3456789', 10, { start: 3, end: 9 }, true]);
      const between = await disk.open('digits.txt', { range: { start: 2, end: 4 } });
      expect([await bytes(between), between.size, between.range]).toEqual(['234', 10, { start: 2, end: 4 }]);
      const last = await disk.open('digits.txt', { range: { last: 4 } });
      expect([await bytes(last), last.size, last.range]).toEqual(['6789', 10, { start: 6, end: 9 }]);
      const cut = await disk.open('digits.txt', { range: { start: 8, end: 500 } });
      expect([await bytes(cut), cut.range]).toEqual(['89', { start: 8, end: 9 }]);
    });

    it('a range of a file bigger than one chunk holds its bytes and no others', async () => {
      const disk = await make();
      const big = new Uint8Array(150_000).map((_, index) => index % 251);
      await disk.put('big.bin', big);
      const file = await disk.open('big.bin', { range: { start: 65_000, end: 140_000 } });
      expect(new Uint8Array(await new Response(file.body).arrayBuffer())).toEqual(big.slice(65_000, 140_001));
    });

    it('opens the whole file, with no range on the result, when none is asked', async () => {
      const disk = await make();
      await disk.put('digits.txt', '0123456789');
      for (const file of [await disk.open('digits.txt'), await disk.open('digits.txt', {}), await disk.open('digits.txt', { range: undefined })]) {
        expect(file.range).toBeUndefined();
        expect(file.acceptsRanges).toBe(true);
        expect(await bytes(file)).toBe('0123456789');
      }
    });

    it('a range that starts at or after the end is unsatisfiable: no bytes, still the size', async () => {
      const disk = await make();
      await disk.put('digits.txt', '0123456789');
      for (const range of [{ start: 10 }, { start: 11, end: 20 }, { last: 0 }]) {
        const file = await disk.open('digits.txt', { range });
        expect([await bytes(file), file.size, file.range]).toEqual(['', 10, 'unsatisfiable']);
      }
    });

    it('an empty file: a start is unsatisfiable, a suffix gives the whole (empty) file', async () => {
      const disk = await make();
      await disk.put('empty.txt', '');
      const start = await disk.open('empty.txt', { range: { start: 0 } });
      expect([await bytes(start), start.size, start.range]).toEqual(['', 0, 'unsatisfiable']);
      const suffix = await disk.open('empty.txt', { range: { last: 5 } });
      expect([await bytes(suffix), suffix.size, suffix.range]).toEqual(['', 0, undefined]);
    });

    it('a suffix of an empty file stays empty when the file is replaced afterwards (memory copies, local closes at once)', async () => {
      const disk = await make();
      await disk.put('empty.txt', '');
      const file = await disk.open('empty.txt', { range: { last: 5 } });
      await disk.put('empty.txt', 'grown after the open');
      expect(await bytes(file)).toBe('');
    });

    it('negative: a range that is not whole numbers, or in two forms, is a RangeError before the file is looked at', async () => {
      const disk = await make();
      for (const range of [{ start: -1 }, { start: 3, end: 2 }, { start: 1.5 }, { last: -1 }, { start: 0, last: 1 }, {}, { start: 0, length: 4 }, { start: 0, End: 4 }, { last: 1, extra: true }]) {
        await expect(disk.open('missing.txt', { range } as never), JSON.stringify(range)).rejects.toThrow(RangeError);
      }
      await expect(disk.open('missing.txt', { range: { start: 0 } })).rejects.toThrow(FileNotFoundError);
    });

    it('negative: a bad key stays refused with a range', async () => {
      const disk = await make();
      await expect(disk.open('../x', { range: { start: 0 } })).rejects.toThrow(InvalidKeyError);
    });

    it('replaced after open: the body keeps the old bytes', async () => {
      const disk = await make();
      await disk.put('digits.txt', '0123456789');
      const file = await disk.open('digits.txt', { range: { start: 2, end: 5 } });
      await disk.put('digits.txt', 'abcdefghij');
      expect(await bytes(file)).toBe('2345');
      expect(await disk.text('digits.txt')).toBe('abcdefghij');
    });

    it('stream(), get() and copy() stay whole', async () => {
      const disk = await make();
      await disk.put('digits.txt', '0123456789');
      await disk.copy('digits.txt', 'copy.txt');
      expect(await disk.text('copy.txt')).toBe('0123456789');
      expect(await text(await disk.stream('digits.txt'))).toBe('0123456789');
    });
  });

  it.skipIf(kind.skip)('exists, delete, move, copy', async () => {
    const disk = await make();
    await disk.put('a/one.txt', '1');
    expect(await disk.exists('a/one.txt')).toBe(true);
    expect(await disk.exists('a/none.txt')).toBe(false);
    expect(await disk.exists('a')).toBe(false); // a directory is not a file
    await disk.copy('a/one.txt', 'b/two.txt');
    expect(await disk.text('b/two.txt')).toBe('1');
    await disk.move('a/one.txt', 'c/three.txt');
    expect(await disk.exists('a/one.txt')).toBe(false);
    expect(await disk.text('c/three.txt')).toBe('1');
    expect(await disk.delete('c/three.txt')).toBe(true);
    expect(await disk.delete('c/three.txt')).toBe(false);
    expect(await disk.delete('never/was.txt')).toBe(false);
  });

  it.skipIf(kind.skip)('lists a directory, or everything below it, sorted', async () => {
    const disk = await make();
    for (const key of ['b.txt', 'a.txt', 'dir/x.txt', 'dir/sub/y.txt', 'other/z.txt']) await disk.put(key, key);
    expect(await disk.list()).toEqual(['a.txt', 'b.txt']);
    expect(await disk.list('', { recursive: true })).toEqual(['a.txt', 'b.txt', 'dir/sub/y.txt', 'dir/x.txt', 'other/z.txt']);
    expect(await disk.list('dir')).toEqual(['dir/x.txt']);
    expect(await disk.list('dir/', { recursive: true })).toEqual(['dir/sub/y.txt', 'dir/x.txt']);
    expect(await disk.list('missing')).toEqual([]);
  });

  it.skipIf(kind.skip)('a missing file: FileNotFoundError for every read', async () => {
    const disk = await make();
    for (const read of [
      () => disk.get('none.txt'),
      () => disk.text('none.txt'),
      () => disk.stream('none.txt'),
      () => disk.open('none.txt'),
      () => disk.size('none.txt'),
      () => disk.mimeType('none.txt'),
      () => disk.lastModified('none.txt'),
      () => disk.move('none.txt', 'x.txt'),
      () => disk.copy('none.txt', 'x.txt'),
    ]) {
      await expect(read()).rejects.toThrow(FileNotFoundError);
    }
  });

  it.skipIf(kind.skip)('refuses keys that leave their directory — on every operation', async () => {
    const disk = await make();
    await disk.put('ok.txt', 'ok');
    for (const key of ['../../.env', 'a/../../x', '/etc/passwd', 'a\u0000.png', '..\\x', 'a//b', '']) {
      for (const run of [
        () => disk.get(key),
        () => disk.put(key, 'x'),
        () => disk.exists(key),
        () => disk.delete(key),
        () => disk.size(key),
        () => disk.open(key),
        () => disk.move('ok.txt', key),
        () => disk.copy('ok.txt', key),
        () => disk.temporaryUrl(key, { expiresIn: 60 }),
        () => disk.list(key === '' ? '../' : key),
      ]) {
        await expect(run()).rejects.toThrow(InvalidKeyError);
      }
    }
    expect(await disk.text('ok.txt')).toBe('ok');
  });

  it.skipIf(kind.skip)('url(): public disks only — a private disk names temporaryUrl()', async () => {
    const open = await make('public');
    expect(open.url('avatars/ä 7.webp')).toMatch(/\/avatars\/%C3%A4%207\.webp$/);
    const closed = await make('private');
    expect(() => closed.url('a.txt')).toThrow(StorageError);
    expect(() => closed.url('a.txt')).toThrow('use temporaryUrl(key, { expiresIn })');
  });

  it.skipIf(kind.skip || kind.name === 's3')('temporaryUrl(): signed by the app (local, memory)', async () => {
    const disk = await make();
    expect(await disk.temporaryUrl('exports/7.json', { expiresIn: { minutes: 5 }, filename: 'export.json' })).toBe('/signed/files/exports/7.json');
    expect(recordingUrls.last).toEqual({ disk: 'files', key: 'exports/7.json', options: { expiresInSeconds: 300, filename: 'export.json' } });
  });

  it.skipIf(kind.skip)('temporaryUrl(): seven days at most — one second more, or eight days, throws a RangeError', async () => {
    const disk = await make();
    await expect(disk.temporaryUrl('a.txt', { expiresIn: 604_800 })).resolves.toEqual(expect.any(String));
    await expect(disk.temporaryUrl('a.txt', { expiresIn: { days: 7 } })).resolves.toEqual(expect.any(String));
    await expect(disk.temporaryUrl('a.txt', { expiresIn: 604_801 })).rejects.toThrow(RangeError);
    await expect(disk.temporaryUrl('a.txt', { expiresIn: { days: 8 } })).rejects.toThrow(/at most 7 days.*route of your own/);
  });
});
