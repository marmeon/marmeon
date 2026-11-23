import { TestClock } from '@marmeon/core/testing';
import { describe, expect, it } from 'vitest';
import { FakeS3 } from './__fixtures__/s3-fake.ts';
import { FileNotFoundError, InvalidKeyError, StorageError } from './errors.ts';
import { S3Disk } from './drivers/s3.ts';
import { lengthOf } from './size.ts';

/** Against the in-memory fake of the SDK: no service, the commands counted. */
describe('the s3 disk and a range', () => {
  const fake = (root = '') => {
    const store = new FakeS3();
    const disk = new S3Disk({ name: 'files', options: { driver: 's3', bucket: 'b', region: 'us-east-1', endpoint: 'http://store.test', credentials: { accessKeyId: 'a', secretAccessKey: 's' }, root, visibility: 'private' }, visibility: 'private', clock: new TestClock(), load: store.load });
    return { store, disk };
  };
  const text = (body: ReadableStream<Uint8Array>) => new Response(body).text();
  const commands = (store: FakeS3) => store.calls.map((call) => call.command);
  const since = (store: FakeS3, count: number) => store.calls.slice(count).map((call) => call.command);

  it('opens each form with one GetObject, its own Range header and only its bytes', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    const cases = [
      [{ start: 3 }, 'bytes=3-', '3456789', { start: 3, end: 9 }],
      [{ start: 2, end: 4 }, 'bytes=2-4', '234', { start: 2, end: 4 }],
      [{ last: 4 }, 'bytes=-4', '6789', { start: 6, end: 9 }],
      [{ start: 8, end: 500 }, 'bytes=8-500', '89', { start: 8, end: 9 }],
    ] as const;
    for (const [range, header, body, resolved] of cases) {
      const before = store.calls.length;
      const file = await disk.open('d.txt', { range });
      expect([await text(file.body), file.size, file.range, file.acceptsRanges], header).toEqual([body, 10, resolved, true]);
      expect(since(store, before)).toEqual(['GetObject']);
      expect(store.calls[before]!.input.Range).toBe(header);
    }
  });

  it('opens the whole file with one GetObject, no Range, no range on the result and acceptsRanges', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    const before = store.calls.length;
    const file = await disk.open('d.txt');
    expect([await text(file.body), file.range, file.acceptsRanges]).toEqual(['0123456789', undefined, true]);
    expect(since(store, before)).toEqual(['GetObject']);
    expect(store.calls[before]!.input.Range).toBeUndefined();
  });

  it('a range behind the end is unsatisfiable: GetObject, then HeadObject for the size, and no bytes', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    const before = store.calls.length;
    const file = await disk.open('d.txt', { range: { start: 10 } });
    expect([await text(file.body), file.size, file.range, file.acceptsRanges, file.contentType]).toEqual(['', 10, 'unsatisfiable', true, 'text/plain']);
    expect(file.lastModified).toBeInstanceOf(Date);
    expect(since(store, before)).toEqual(['GetObject', 'HeadObject']);
  });

  it('the last 0 bytes ask the store for the head alone', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    const before = store.calls.length;
    const file = await disk.open('d.txt', { range: { last: 0 } });
    expect([await text(file.body), file.size, file.range]).toEqual(['', 10, 'unsatisfiable']);
    expect(since(store, before)).toEqual(['HeadObject']);
  });

  it('an empty file: a start is unsatisfiable, a suffix is the empty file with no range', async () => {
    const { store, disk } = fake();
    await disk.put('e.txt', '');
    const start = await disk.open('e.txt', { range: { start: 0 } });
    expect([await text(start.body), start.size, start.range]).toEqual(['', 0, 'unsatisfiable']);
    const before = store.calls.length;
    const suffix = await disk.open('e.txt', { range: { last: 5 } });
    expect([await text(suffix.body), suffix.size, suffix.range, suffix.acceptsRanges]).toEqual(['', 0, undefined, true]);
    expect(since(store, before)).toEqual(['GetObject', 'HeadObject', 'GetObject']);
  });

  it('a file that grew between the GetObject and the HeadObject is read whole, once more, with no range', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123');
    store.afterInvalidRange = () => store.post('b', 'd.txt', new TextEncoder().encode('0123456789'));
    const before = store.calls.length;
    const file = await disk.open('d.txt', { range: { start: 6 } });
    expect([await text(file.body), file.size, file.range]).toEqual(['0123456789', 10, undefined]);
    expect(since(store, before)).toEqual(['GetObject', 'HeadObject', 'GetObject']);
  });

  it('a store that ignores Range sends the whole file, which is the answer with no range', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    store.ignoreRange = true;
    const file = await disk.open('d.txt', { range: { start: 2, end: 4 } });
    expect([await text(file.body), file.size, file.range, file.acceptsRanges]).toEqual(['0123456789', 10, undefined, true]);
    const cancelled = store.cancelled;
    const behind = await disk.open('d.txt', { range: { start: 10 } });
    expect([await text(behind.body), behind.size, behind.range]).toEqual(['', 10, 'unsatisfiable']);
    expect(store.cancelled).toBe(cancelled + 1);
  });

  it('a store that names no length: a range answer takes its size from Content-Range, never from ContentLength', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    store.withoutLength = true;
    const file = await disk.open('d.txt', { range: { start: 2, end: 4 } });
    expect([await text(file.body), file.size, file.range]).toEqual(['234', 10, { start: 2, end: 4 }]);
  });

  it('a store that ignores Range and names no length: the whole file, its size left unknown', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    store.ignoreRange = true;
    store.withoutLength = true;
    const file = await disk.open('d.txt', { range: { start: 2 } });
    expect([await text(file.body), file.range]).toEqual(['0123456789', undefined]);
    expect(lengthOf(file)).toBeUndefined();
  });

  it('negative: a Content-Range that is malformed, or not the asked bytes, is refused and the body cancelled', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    const unreadable = /Content-Range this driver does not read/;
    const other = /answered the range \{"start":2,"end":4\} of "d.txt" on the disk "files" with the bytes \d+-\d+ of \d+/;
    const cases: [string | null, RegExp][] = [
      ['bytes 2-4/*', unreadable],
      ['items 2-4/10', unreadable],
      ['bytes 2-4/10 ', unreadable],
      [null, unreadable],
      ['bytes 3-4/10', other],
      ['bytes 2-9/10', other],
      ['bytes 2-4/4', other],
      ['bytes 2-4/99999999999999999999', other],
    ];
    for (const [contentRange, message] of cases) {
      store.contentRange = contentRange;
      const cancelled = store.cancelled;
      await expect(disk.open('d.txt', { range: { start: 2, end: 4 } }), String(contentRange)).rejects.toThrow(message);
      expect(store.cancelled, String(contentRange)).toBe(cancelled + 1);
    }
  });

  it('a range answer with no length is held to the range: a longer or a shorter body fails with a StorageError, and cancel reaches the store', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    store.withoutLength = true;
    const read = async (bytes: string) => {
      store.rangedBody = new TextEncoder().encode(bytes);
      const file = await disk.open('d.txt', { range: { start: 2, end: 4 } });
      return text(file.body);
    };
    await expect(read('234')).resolves.toBe('234');
    await expect(read('2345')).rejects.toThrow(/longer than its 3 bytes/);
    await expect(read('23')).rejects.toThrow(/ended after 2 of 3 bytes/);
    await disk.put('big.bin', new Uint8Array(200_000));
    store.rangedBody = undefined;
    const cancelled = store.cancelled;
    const file = await disk.open('big.bin', { range: { start: 0, end: 150_000 } });
    await file.body.cancel();
    expect(store.cancelled).toBe(cancelled + 1);
  });

  it('an answer that is not a 206 but carries a Content-Range: the range when its body fits, the whole file when it says so, else refused', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    store.rangedStatus = 200;
    store.contentRange = 'bytes 2-4/10';
    const sliced = await disk.open('d.txt', { range: { start: 2, end: 4 } });
    expect([await text(sliced.body), sliced.size, sliced.range]).toEqual(['234', 10, { start: 2, end: 4 }]);
    store.rangedBody = new TextEncoder().encode('0123456789');
    store.contentRange = 'bytes 0-9/10';
    const whole = await disk.open('d.txt', { range: { start: 2, end: 4 } });
    expect([await text(whole.body), whole.size, whole.range, whole.acceptsRanges]).toEqual(['0123456789', 10, undefined, true]);
    for (const contentRange of ['bytes 2-4/10', 'bytes 1-9/10', 'bytes 0-8/10', 'bytes 0-9/11']) {
      store.contentRange = contentRange;
      const cancelled = store.cancelled;
      await expect(disk.open('d.txt', { range: { start: 2, end: 4 } }), contentRange).rejects.toThrow(StorageError);
      expect(store.cancelled, contentRange).toBe(cancelled + 1);
    }
  });

  it('an answer with no status at all is believed by its Content-Range: the range when it fits, refused when it is the whole file', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    store.rangedStatus = null;
    const sliced = await disk.open('d.txt', { range: { start: 2, end: 4 } });
    expect([await text(sliced.body), sliced.range]).toEqual(['234', { start: 2, end: 4 }]);
    store.rangedBody = new TextEncoder().encode('0123456789');
    store.contentRange = 'bytes 0-9/10';
    await expect(disk.open('d.txt', { range: { start: 2, end: 4 } })).rejects.toThrow(StorageError);
  });

  it('a store that names no length for the head: the last 0 bytes and a range behind the end read the file whole, its size left unknown', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    store.withoutLength = true;
    let before = store.calls.length;
    const none = await disk.open('d.txt', { range: { last: 0 } });
    expect([await text(none.body), none.range, lengthOf(none)]).toEqual(['0123456789', undefined, undefined]);
    expect(since(store, before)).toEqual(['HeadObject', 'GetObject']);
    before = store.calls.length;
    const behind = await disk.open('d.txt', { range: { start: 10 } });
    expect([await text(behind.body), behind.range, lengthOf(behind)]).toEqual(['0123456789', undefined, undefined]);
    expect(since(store, before)).toEqual(['GetObject', 'HeadObject', 'GetObject']);
  });

  it('negative: a body of another length than its Content-Range names is refused and cancelled', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    store.contentLength = 5;
    await expect(disk.open('d.txt', { range: { start: 2, end: 4 } })).rejects.toThrow(StorageError);
    expect(store.cancelled).toBe(1);
  });

  it('negative: a 403 is not read as an unsatisfiable range', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    store.failNextGet = { name: 'AccessDenied', status: 403 };
    const before = store.calls.length;
    await expect(disk.open('d.txt', { range: { start: 10 } })).rejects.toMatchObject({ name: 'AccessDenied' });
    expect(since(store, before)).toEqual(['GetObject']);
  });

  it('negative: a file deleted between the GetObject and the HeadObject is a FileNotFoundError', async () => {
    const { store, disk } = fake();
    await disk.put('d.txt', '0123456789');
    store.afterInvalidRange = () => store.objects.delete('b/d.txt');
    await expect(disk.open('d.txt', { range: { start: 10 } })).rejects.toThrow(FileNotFoundError);
  });

  it('negative: a missing file and a bad key stay refused with a range, a malformed range is a RangeError', async () => {
    const { store, disk } = fake('root/');
    await disk.put('d.txt', '0123456789');
    await expect(disk.open('missing.txt', { range: { start: 0 } })).rejects.toThrow(FileNotFoundError);
    await expect(disk.open('missing.txt', { range: { last: 0 } })).rejects.toThrow(FileNotFoundError);
    const before = store.calls.length;
    await expect(disk.open('../x', { range: { start: 0 } })).rejects.toThrow(InvalidKeyError);
    await expect(disk.open('../x', { range: { last: 0 } })).rejects.toThrow(InvalidKeyError);
    expect(store.calls.length).toBe(before);
    for (const range of [{ start: -1 }, { start: 3, end: 2 }, { start: 0, last: 1 }]) {
      await expect(disk.open('d.txt', { range } as never), JSON.stringify(range)).rejects.toThrow(RangeError);
    }
  });

  it('the root prefix is in the key of the ranged request', async () => {
    const { store, disk } = fake('root/');
    await disk.put('d.txt', '0123456789');
    await disk.open('d.txt', { range: { start: 1, end: 2 } });
    expect(store.calledWith('GetObject').at(-1)).toMatchObject({ Key: 'root/d.txt', Range: 'bytes=1-2' });
    expect(commands(store).filter((name) => name === 'HeadObject')).toEqual([]);
  });
});
