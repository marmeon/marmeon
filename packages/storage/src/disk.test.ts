import { Readable } from 'node:stream';
import { TestClock } from '@marmeon/core';
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
    expect(recordingUrls.last).toEqual({ disk: 'files', key: 'exports/7.json', options: { expiresIn: { minutes: 5 }, filename: 'export.json' } });
  });
});
