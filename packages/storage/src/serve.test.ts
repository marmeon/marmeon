import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { freshDirectory, recordingUrls, removeDirectories } from './__fixtures__/disks.ts';
import { LocalDisk } from './drivers/local.ts';
import type { ByteRange, Disk, OpenedFile } from './disk.ts';
import { FileNotFoundError, StorageError } from './index.ts';
import { parseRange, resolveRange } from './ranges.ts';
import { frameworkDisk, managerOf } from './test-helpers/framework-disk.ts';
import { serveFile } from './serve.ts';

afterAll(removeDirectories);

const options = { cacheControl: 'private' };
const get = (headers: Record<string, string> = {}, method = 'GET') => new Request('http://localhost/files/a.txt', { method, headers });

/** A hand-made disk answering `open()` with a body that counts its reads and cancels. */
function handMade(size: unknown, text = 'hello') {
  const state = { pulls: 0, cancelled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
    cancel() {
      state.cancelled++;
    },
  }, { highWaterMark: 0 });
  const file = { body, size: size as number, lastModified: new Date(0), contentType: 'text/plain' } satisfies OpenedFile;
  return { disk: { open: async () => file } as unknown as Disk, state };
}

describe('the length serveFile announces', () => {
  it('takes a size as a header takes it: digits in a string and a bigint count', async () => {
    for (const size of [5, '5', ' 5 ', 5n]) {
      const response = await serveFile(handMade(size).disk, 'a.txt', get(), options);
      expect(response.headers.get('content-length'), String(size)).toBe('5');
      expect(await response.text()).toBe('hello');
    }
  });

  it('without a known size it sends the body to its end, without Content-Length', async () => {
    for (const size of [Number.NaN, -1, 1.5, Infinity, 2 ** 53, undefined, null, '']) {
      for (const method of ['GET', 'HEAD']) {
        const { disk } = handMade(size);
        const response = await serveFile(disk, 'a.txt', get({}, method), options);
        expect([response.status, response.headers.get('content-length')], String(size)).toEqual([200, null]);
        expect(await response.text()).toBe(method === 'GET' ? 'hello' : '');
      }
    }
  });

  it('a size of 0 is served as an empty file', async () => {
    const { disk } = handMade(0, '');
    const response = await serveFile(disk, 'a.txt', get(), options);
    expect(response.headers.get('content-length')).toBe('0');
    expect(await response.text()).toBe('');
  });

  it('HEAD and 304 read nothing from the body', async () => {
    const head = handMade(5);
    const response = await serveFile(head.disk, 'a.txt', get({}, 'HEAD'), options);
    expect([response.status, response.headers.get('content-length')]).toEqual([200, '5']);
    expect([head.state.pulls, head.state.cancelled]).toEqual([0, 1]);
    const unchanged = handMade(5);
    const notModified = await serveFile(unchanged.disk, 'a.txt', get({ 'if-modified-since': new Date().toUTCString() }), options);
    expect(notModified.status).toBe(304);
    expect([unchanged.state.pulls, unchanged.state.cancelled]).toEqual([0, 1]);
  });
});

describe('a real empty file of a local disk', () => {
  it('announces Content-Length: 0 on GET and HEAD, as before', async () => {
    const root = join(freshDirectory(), 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'empty.txt'), '');
    const disk = new LocalDisk({ name: 'local', root, visibility: 'private', temporaryUrls: recordingUrls });
    for (const method of ['GET', 'HEAD']) {
      const response = await serveFile(disk, 'empty.txt', get({}, method), options);
      expect([response.status, response.headers.get('content-length')], method).toEqual([200, '0']);
      expect(await response.text()).toBe('');
    }
  });
});

// ---- ranges ----------------------------------------------------------------------------------------------------------

const TEXT = '0123456789'; // ten bytes: the ranges below are read off it
const NOW = new Date('2025-06-01T12:00:00Z');
const OLD = new Date('2025-01-02T03:04:05Z');
const OLD_TEXT = OLD.toUTCString();
const withRanges = { cacheControl: 'public, max-age=0, must-revalidate', ranges: true };

afterEach(() => vi.useRealTimers());

/** A stand-in disk that slices like a driver that opted in. `answer` changes what it returns; `claims` is its `acceptsRanges`. */
function slicing({ lastModified = OLD, claims = true, answer, text = TEXT }: { lastModified?: Date; claims?: boolean | undefined; answer?: (file: OpenedFile, range: ByteRange | undefined) => OpenedFile; text?: string } = {}) {
  const calls: unknown[][] = [];
  const state = { cancelled: 0 };
  const bytes = new TextEncoder().encode(text);
  const stream = (part: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(part);
        controller.close();
      },
      cancel() {
        state.cancelled++;
      },
    });
  const disk = frameworkDisk(async (...args: unknown[]) => {
      calls.push(args);
      const range = (args[1] as { range?: ByteRange } | undefined)?.range;
      const resolved = range === undefined || !claims ? undefined : resolveRange(range, bytes.length);
      const base = { size: bytes.length, lastModified, contentType: 'text/plain', acceptsRanges: claims || undefined };
      const file: OpenedFile =
        resolved === undefined
          ? { ...base, body: stream(bytes) }
          : resolved === 'unsatisfiable'
            ? { ...base, body: stream(new Uint8Array()), range: 'unsatisfiable' }
            : { ...base, body: stream(bytes.slice(resolved.start, resolved.end + 1)), range: resolved };
      return answer ? answer(file, range) : file;
  });
  return { disk, calls, state };
}

const ranged = (range: string, headers: Record<string, string> = {}, method = 'GET') => get({ range, ...headers }, method);

describe('serveFile with ranges: true', () => {
  it.each<[string, string, string, string, ByteRange]>([
    ['first and last', 'bytes=2-4', '234', 'bytes 2-4/10', { start: 2, end: 4 }],
    ['first, no last', 'bytes=7-', '789', 'bytes 7-9/10', { start: 7 }],
    ['a suffix', 'bytes=-3', '789', 'bytes 7-9/10', { last: 3 }],
    ['a last cut to the file', 'bytes=8-99', '89', 'bytes 8-9/10', { start: 8, end: 99 }],
    ['a suffix longer than the file: the whole file as 206', 'bytes=-99', TEXT, 'bytes 0-9/10', { last: 99 }],
    ['the whole file by its bounds', 'bytes=0-9', TEXT, 'bytes 0-9/10', { start: 0, end: 9 }],
    ['the unit in capitals', 'BYTES=0-1', '01', 'bytes 0-1/10', { start: 0, end: 1 }],
    ['a huge last, cut', `bytes=5-${'9'.repeat(10_000)}`, '56789', 'bytes 5-9/10', { start: 5, end: Number.MAX_SAFE_INTEGER }],
  ])('%s: 206 with the bytes, Content-Range and the length of the slice', async (_name, header, body, contentRange, asked) => {
    const { disk, calls } = slicing();
    const response = await serveFile(disk, 'a.txt', ranged(header), withRanges);
    expect([response.status, response.headers.get('content-range'), response.headers.get('content-length'), response.headers.get('accept-ranges')]).toEqual([206, contentRange, String(body.length), 'bytes']);
    expect(await response.text()).toBe(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({ range: asked });
    expect(parseRange(header)).toEqual(asked);
  });

  it.each<[string, string]>([
    ['a start at the size', 'bytes=10-'],
    ['a start past the size', 'bytes=11-20'],
    ['the last 0 bytes', 'bytes=-0'],
    ['a huge start', `bytes=${'9'.repeat(10_000)}-`],
  ])('%s: 416 with "bytes */size", no body, never cached', async (_name, header) => {
    const { disk, state } = slicing();
    const response = await serveFile(disk, 'a.txt', ranged(header), withRanges);
    expect([response.status, response.headers.get('content-range'), response.headers.get('content-length'), response.headers.get('cache-control'), response.headers.get('accept-ranges')]).toEqual([416, 'bytes */10', '0', 'no-store', 'bytes']);
    expect(await response.text()).toBe('');
    expect(state.cancelled).toBe(1);
  });

  it('an empty file: a start is 416 with */0, a suffix is the empty file as 200', async () => {
    const empty = slicing({ text: '' });
    const start = await serveFile(empty.disk, 'a.txt', ranged('bytes=0-'), withRanges);
    expect([start.status, start.headers.get('content-range'), start.headers.get('content-length')]).toEqual([416, 'bytes */0', '0']);
    const suffix = await serveFile(slicing({ text: '' }).disk, 'a.txt', ranged('bytes=-5'), withRanges);
    expect([suffix.status, suffix.headers.get('content-range'), suffix.headers.get('content-length'), await suffix.text()]).toEqual([200, null, '0', '']);
  });

  it.each<[string, string | undefined]>([
    ['no Range', undefined],
    ['another unit', 'items=0-1'],
    ['invalid syntax', 'bytes=a-b'],
    ['a last before its first', 'bytes=5-2'],
    ['two ranges', 'bytes=0-1,3-4'],
    ['a duplicated header joined by a comma', 'bytes=0-1, bytes=2-3'],
  ])('%s: the Range is ignored, the whole file is 200 and the disk is called with the key alone', async (_name, header) => {
    const { disk, calls } = slicing();
    const response = await serveFile(disk, 'a.txt', header === undefined ? get() : ranged(header), withRanges);
    expect([response.status, response.headers.get('content-range'), response.headers.get('content-length'), response.headers.get('accept-ranges')]).toEqual([200, null, '10', 'bytes']);
    expect(await response.text()).toBe(TEXT);
    expect(calls.map((call) => call.length)).toEqual([1]);
  });

  it('keeps nosniff, the sandbox, the disposition, the type, Last-Modified and the caller\'s Cache-Control on 206 and 416', async () => {
    for (const header of ['bytes=0-1', 'bytes=50-']) {
      const response = await serveFile(slicing().disk, 'dir/a.html', ranged(header), { ...withRanges, filename: 'x.html' });
      expect(response.status).toBe(header === 'bytes=0-1' ? 206 : 416);
      expect(Object.fromEntries(response.headers)).toMatchObject({
        'content-type': 'text/plain',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
        'content-disposition': 'attachment; filename="x.html"; filename*=UTF-8\'\'x.html',
        'last-modified': OLD_TEXT,
        'cache-control': header === 'bytes=0-1' ? withRanges.cacheControl : 'no-store',
      });
    }
  });

  it('HEAD ignores Range and If-Range: 200 with the whole length, Accept-Ranges, the body cancelled', async () => {
    const { disk, calls, state } = slicing();
    const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': OLD_TEXT }, 'HEAD'), withRanges);
    expect([response.status, response.headers.get('content-length'), response.headers.get('accept-ranges'), response.headers.get('content-range'), await response.text()]).toEqual([200, '10', 'bytes', null, '']);
    expect(calls.map((call) => call.length)).toEqual([1]);
    expect(state.cancelled).toBe(1);
  });

  it('If-Modified-Since comes before Range, also before a 416: 304, Accept-Ranges, the body cancelled', async () => {
    for (const header of ['bytes=2-4', 'bytes=50-']) {
      const { disk, state } = slicing();
      const response = await serveFile(disk, 'a.txt', ranged(header, { 'if-modified-since': OLD_TEXT }), withRanges);
      expect([response.status, response.headers.get('accept-ranges'), response.headers.get('content-range'), await response.text()], header).toEqual([304, 'bytes', null, '']);
      expect(state.cancelled).toBe(1);
    }
  });

  describe('If-Range', () => {
    const at = (time: Date) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(time);
    };

    it('the exact Last-Modified text of an older file: the range is answered', async () => {
      at(NOW);
      const { disk, calls } = slicing();
      const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': OLD_TEXT }), withRanges);
      expect([response.status, await response.text()]).toEqual([206, '234']);
      expect(calls).toHaveLength(1);
    });

    it.each<[string, () => { lastModified: Date; ifRange: (lastModified: Date) => string }]>([
      ['a stale date', () => ({ lastModified: OLD, ifRange: () => new Date(OLD.getTime() - 86_400_000).toUTCString() })],
      ['a later date', () => ({ lastModified: OLD, ifRange: () => new Date(OLD.getTime() + 1000).toUTCString() })],
      ['the date in another format', () => ({ lastModified: OLD, ifRange: () => OLD.toISOString() })],
      ['an entity tag', () => ({ lastModified: OLD, ifRange: () => '"abc"' })],
      ['a weak entity tag', () => ({ lastModified: OLD, ifRange: () => 'W/"abc"' })],
      ['text that is no date', () => ({ lastModified: OLD, ifRange: () => 'yesterday' })],
      ['a file changed under half a second ago', () => ({ lastModified: new Date(NOW.getTime() - 500), ifRange: (time) => time.toUTCString() })],
      ['a file changed 999 ms ago', () => ({ lastModified: new Date(NOW.getTime() - 999), ifRange: (time) => time.toUTCString() })],
      ['a file from the future', () => ({ lastModified: new Date(NOW.getTime() + 60_000), ifRange: (time) => time.toUTCString() })],
      ['a file at the epoch', () => ({ lastModified: new Date(0), ifRange: (time) => time.toUTCString() })],
    ])('%s: 200 with the whole file, never a slice', async (_name, setUp) => {
      at(NOW);
      const { lastModified, ifRange } = setUp();
      const { disk } = slicing({ lastModified });
      const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': ifRange(new Date(Math.floor(lastModified.getTime() / 1000) * 1000)) }), withRanges);
      expect([response.status, response.headers.get('content-range'), response.headers.get('content-length')]).toEqual([200, null, '10']);
      expect(await response.text()).toBe(TEXT);
    });

    it('a file one second old is answered; the same file at under one second is not', async () => {
      const modified = new Date('2025-06-01T11:59:59Z');
      at(new Date('2025-06-01T12:00:00Z'));
      const strong = await serveFile(slicing({ lastModified: modified }).disk, 'a.txt', ranged('bytes=2-4', { 'if-range': modified.toUTCString() }), withRanges);
      expect(strong.status).toBe(206);
      at(new Date('2025-06-01T11:59:59.999Z'));
      const weak = await serveFile(slicing({ lastModified: modified }).disk, 'a.txt', ranged('bytes=2-4', { 'if-range': modified.toUTCString() }), withRanges);
      expect(weak.status).toBe(200);
    });

    it('a date that does not hold cancels the slice and opens the file again with the key alone: its headers are the second snapshot\'s', async () => {
      at(NOW);
      const second = new Date('2025-02-03T04:05:06Z');
      let opened = 0;
      const first = slicing();
      const replaced = slicing({ lastModified: second, text: 'abcdefghijklmnop' });
      const disk = frameworkDisk(async (...args: unknown[]) => (++opened === 1 ? first.disk.open(args[0] as string, args[1] as never) : replaced.disk.open(args[0] as string, ...(args.slice(1) as []))));
      const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': new Date(OLD.getTime() - 1000).toUTCString() }), withRanges);
      expect([response.status, response.headers.get('content-length'), response.headers.get('last-modified'), await response.text()]).toEqual([200, '16', second.toUTCString(), 'abcdefghijklmnop']);
      expect(first.state.cancelled).toBe(1);
      expect(first.calls[0]![1]).toEqual({ range: { start: 2, end: 4 } });
      expect(replaced.calls.map((call) => call.length)).toEqual([1]);
    });

    it('a file that is gone at the second open is a 404, and the first body is cancelled', async () => {
      at(NOW);
      const first = slicing();
      let opened = 0;
      const disk = frameworkDisk(async (...args: unknown[]) => {
        if (++opened === 2) throw new FileNotFoundError('stand-in', 'a.txt');
        return first.disk.open(args[0] as string, args[1] as never);
      });
      const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': 'Mon, 01 Jan 2024 00:00:00 GMT' }), withRanges);
      expect(response.status).toBe(404);
      expect(first.state.cancelled).toBe(1);
    });

    it('an entity tag or text that is no date asks the disk for no range at all', async () => {
      for (const ifRange of ['"abc"', 'W/"abc"', 'later']) {
        const { disk, calls } = slicing();
        const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': ifRange }), withRanges);
        expect([response.status, calls.map((call) => call.length)], ifRange).toEqual([200, [1]]);
        await response.text();
      }
    });

    it('with a range nobody can satisfy: a fresh date gets 416, a stale one gets the whole file', async () => {
      at(NOW);
      const fresh = await serveFile(slicing().disk, 'a.txt', ranged('bytes=50-', { 'if-range': OLD_TEXT }), withRanges);
      expect([fresh.status, fresh.headers.get('content-range')]).toEqual([416, 'bytes */10']);
      const stale = await serveFile(slicing().disk, 'a.txt', ranged('bytes=50-', { 'if-range': 'Mon, 01 Jan 2024 00:00:00 GMT' }), withRanges);
      expect([stale.status, await stale.text()]).toEqual([200, TEXT]);
    });

    it('If-Modified-Since still comes first: 304, whatever If-Range says', async () => {
      at(NOW);
      for (const ifRange of [OLD_TEXT, 'Mon, 01 Jan 2024 00:00:00 GMT']) {
        const { disk, state, calls } = slicing();
        const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': ifRange, 'if-modified-since': OLD_TEXT }), withRanges);
        expect([response.status, calls.length, state.cancelled], ifRange).toEqual([304, 1, 1]);
      }
    });

    it('is ignored on a request without a Range', async () => {
      at(NOW);
      const { disk, calls } = slicing();
      const plain = await serveFile(disk, 'a.txt', get({ 'if-range': OLD_TEXT }), withRanges);
      expect([plain.status, await plain.text(), calls.map((call) => call.length)]).toEqual([200, TEXT, [1]]);
    });
  });

  describe('a disk that does not honour ranges', () => {
    it('answers 200 with the whole file and no Accept-Ranges', async () => {
      const { disk } = slicing({ claims: false });
      const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4'), withRanges);
      expect([response.status, response.headers.get('accept-ranges'), response.headers.get('content-range'), response.headers.get('content-length'), await response.text()]).toEqual([200, null, null, '10', TEXT]);
    });

    it('a stand-in without the claim whose answer is the requested range is served as that range: the answer is confirmed, the claim is not needed', async () => {
      const { disk } = slicing({ claims: false, answer: (file) => ({ ...file, range: { start: 2, end: 4 } }) });
      const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4'), withRanges);
      expect([response.status, response.headers.get('content-range'), response.headers.get('accept-ranges')]).toEqual([206, 'bytes 2-4/10', 'bytes']);
    });
  });

  describe('a disk whose answer the framework did not confirm (a stand-in, a wrapper)', () => {
    it.each<[string, (file: OpenedFile) => OpenedFile]>([
      ['bounds that are not the requested ones', (file) => ({ ...file, range: { start: 0, end: 3 } })],
      ['an end past the file', (file) => ({ ...file, range: { start: 2, end: 40 } })],
      ['a start past the end', (file) => ({ ...file, range: { start: 5, end: 4 } })],
      ['"unsatisfiable" for a range that fits', (file) => ({ ...file, range: 'unsatisfiable' })],
      ['a range that is not a range', (file) => ({ ...file, range: 'bytes 2-4/10' as never })],
      ['a size that is no number', (file) => ({ ...file, size: 'big' as never })],
      ['a negative size', (file) => ({ ...file, size: -1 })],
    ])('%s: a StorageError, and the body is cancelled', async (_name, change) => {
      const { disk, state } = slicing({ answer: change });
      await expect(serveFile(disk, 'a.txt', ranged('bytes=2-4'), withRanges)).rejects.toBeInstanceOf(StorageError);
      expect(state.cancelled).toBe(1);
    });

    it('announces the length of the confirmed range, whatever the body holds: a body that streams too much does not change it', async () => {
      const { disk } = slicing({ answer: (file) => ({ ...file, body: new Response('2345678').body! }) });
      const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4'), withRanges);
      expect([response.status, response.headers.get('content-length'), response.headers.get('content-range')]).toEqual([206, '3', 'bytes 2-4/10']);
    });

    it('reads the range once: a range that changes between reads cannot give the header another value than the one confirmed', async () => {
      let reads = 0;
      const { disk } = slicing({
        answer: (file) =>
          Object.defineProperty({ ...file }, 'range', { get: () => (++reads === 1 ? { start: 2, end: 4 } : { start: 0, end: 9 }) }),
      });
      const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4'), withRanges);
      expect([response.status, response.headers.get('content-range'), response.headers.get('content-length')]).toEqual([206, 'bytes 2-4/10', '3']);
      expect(reads).toBe(1);
    });

    it('a range on the answer to a request that asked for none is not trusted', async () => {
      for (const header of [undefined, 'bytes=a-b']) {
        const { disk } = slicing({ answer: (file) => ({ ...file, range: { start: 2, end: 4 } }) });
        const response = await serveFile(disk, 'a.txt', header === undefined ? get() : ranged(header), withRanges);
        expect([response.status, response.headers.get('content-range'), response.headers.get('content-length')], String(header)).toEqual([200, null, '10']);
      }
    });

    it('an error from open() other than a missing file is thrown; a missing file is 404', async () => {
      const failing = frameworkDisk(async () => Promise.reject(new Error('disk on fire')));
      await expect(serveFile(failing, 'a.txt', ranged('bytes=0-1'), withRanges)).rejects.toThrow('disk on fire');
      const missing = frameworkDisk(async () => Promise.reject(new FileNotFoundError('stand-in', 'a.txt')));
      expect((await serveFile(missing, 'a.txt', ranged('bytes=0-1'), withRanges)).status).toBe(404);
    });
  });

  describe('without the option', () => {
    it.each([
      ['no ranges option', { cacheControl: 'private' }],
      ['ranges: false', { cacheControl: 'private', ranges: false }],
      ['ranges not a boolean', { cacheControl: 'private', ranges: 'yes' as never }],
    ])('%s: a Range gets today\'s response, and open() gets the key alone', async (_name, serveOptions) => {
      const { disk, calls } = slicing();
      const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': OLD_TEXT }), serveOptions);
      expect([response.status, response.headers.get('content-range'), response.headers.get('accept-ranges'), response.headers.get('content-length')]).toEqual([200, null, null, '10']);
      expect(await response.text()).toBe(TEXT);
      expect(calls.map((call) => call.length)).toEqual([1]);
    });

    it('a route that tests for status 200 still sees 200 for a ranged GET', async () => {
      const { disk } = slicing();
      const route = async (request: Request) => (await serveFile(disk, 'a.txt', request, { cacheControl: 'private' })).status === 200;
      expect(await route(ranged('bytes=2-4'))).toBe(true);
    });

    it('a disk that claims ranges gets no Accept-Ranges unless the option is on', async () => {
      for (const method of ['GET', 'HEAD']) {
        const response = await serveFile(slicing().disk, 'a.txt', get({}, method), { cacheControl: 'private' });
        expect(response.headers.get('accept-ranges'), method).toBeNull();
      }
    });
  });

  it('a thrown error cancels the body', async () => {
    const throwing = slicing({ answer: (file) => ({ ...file, range: { start: 0, end: 0 } }) });
    await expect(serveFile(throwing.disk, 'a.txt', ranged('bytes=2-4'), withRanges)).rejects.toThrow();
    expect(throwing.state.cancelled).toBe(1);
  });

  it('real bytes of a local disk of Storage: 206 with the slice, 416 beyond the end', async () => {
    const root = join(freshDirectory(), 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'a.txt'), TEXT);
    const disk = managerOf({ files: { driver: 'local', root } }, root).named('files');
    const part = await serveFile(disk, 'a.txt', ranged('bytes=-4'), withRanges);
    expect([part.status, part.headers.get('content-range'), await part.text()]).toEqual([206, 'bytes 6-9/10', '6789']);
    const beyond = await serveFile(disk, 'a.txt', ranged('bytes=10-'), withRanges);
    expect([beyond.status, beyond.headers.get('content-range')]).toEqual([416, 'bytes */10']);
  });
});

describe('serveFile asks for a range of a disk from Storage only', () => {
  const secret = (text: string) => text.replace(/SECRET\d+/g, '#'.repeat(7));

  /** An app's own disk around a memory disk of Storage: it redacts what `open()` returns and forwards `open(...args)`. */
  function redacting() {
    const inner = managerOf({ files: { driver: 'memory' } }, '/').named('files');
    const calls: unknown[][] = [];
    const wrapper = {
      open: async (...args: unknown[]) => {
        calls.push(args);
        const file = await (inner.open as (...a: unknown[]) => Promise<OpenedFile>)(...args);
        const redacted = secret(await new Response(file.body).text());
        const bytes = new TextEncoder().encode(redacted);
        // A slice of the redacted text under the inner disk's range and size: what a forwarding wrapper hands out.
        return { ...file, body: new Response(file.range === undefined ? bytes : bytes.slice(0, file.range === 'unsatisfiable' ? 0 : file.range.end - file.range.start + 1)).body!, size: file.range === undefined ? bytes.length : file.size };
      },
    } as unknown as Disk;
    return { inner, wrapper, calls };
  }

  it('a wrapper that redacts and forwards open(...args) is called with the key alone and sends the redacted whole file, never a slice', async () => {
    const { inner, wrapper, calls } = redacting();
    await inner.put('note.txt', 'ok SECRET123 tail');
    for (const header of ['bytes=7-', 'bytes=0-6', 'bytes=-4']) {
      const response = await serveFile(wrapper, 'note.txt', ranged(header), withRanges);
      expect([response.status, response.headers.get('accept-ranges'), response.headers.get('content-range'), await response.text()], header).toEqual([200, null, null, 'ok ####### tail']);
    }
    expect(calls.map((call) => call.length)).toEqual([1, 1, 1]);
  });

  it('a Proxy of a disk from Storage, and an object that copies one, are not one: the whole file, the key alone', async () => {
    const { disk } = slicing();
    const open = vi.mocked(disk.open);
    const proxy = new Proxy(disk, {});
    const copy = { ...disk, open: (key: string, options?: never) => disk.open(key, options) } as unknown as Disk;
    for (const other of [proxy, copy]) {
      open.mockClear();
      const response = await serveFile(other, 'a.txt', ranged('bytes=2-4'), withRanges);
      expect([response.status, response.headers.get('accept-ranges'), await response.text()]).toEqual([200, null, TEXT]);
      expect(open.mock.calls.every((call) => call.length === 1 || call[1] === undefined)).toBe(true);
    }
  });

  it('a stand-in that claims acceptsRanges but is not from Storage gets no Accept-Ranges', async () => {
    const claiming = { open: async () => ({ body: new Response(TEXT).body!, size: 10, lastModified: OLD, contentType: 'text/plain', acceptsRanges: true }) } as unknown as Disk;
    for (const method of ['GET', 'HEAD']) {
      const response = await serveFile(claiming, 'a.txt', get({}, method), withRanges);
      expect(response.headers.get('accept-ranges'), method).toBeNull();
    }
  });
});

describe('what serveFile reads of an open file', () => {
  /** A file whose every field is a getter that counts its reads. */
  function counting(fields: { size?: unknown; throws?: 'size' | 'acceptsRanges' | 'lastModified' } = {}) {
    const reads: Record<string, number> = {};
    const state = { cancelled: 0 };
    const body = { cancel: async () => void state.cancelled++, toString: () => { throw new Error('not a body'); } };
    const values: Record<string, unknown> = { body, size: fields.size ?? 5, lastModified: OLD, contentType: 'text/plain', acceptsRanges: true, range: undefined };
    const file = {};
    for (const [name, value] of Object.entries(values)) {
      Object.defineProperty(file, name, {
        enumerable: true,
        get() {
          reads[name] = (reads[name] ?? 0) + 1;
          if (fields.throws === name) throw new Error(`${name} is not readable`);
          return value;
        },
      });
    }
    return { disk: frameworkDisk(async () => file), reads, state };
  }

  it('reads every field once, also with a range and an If-Range date', async () => {
    const ok = new Response('hello').body!;
    const reads: Record<string, number> = {};
    const file = {};
    for (const [name, value] of Object.entries({ body: ok, size: 5, lastModified: OLD, contentType: 'text/plain', acceptsRanges: true, range: { start: 1, end: 3 } })) {
      Object.defineProperty(file, name, { enumerable: true, get: () => ((reads[name] = (reads[name] ?? 0) + 1), value) });
    }
    const disk = frameworkDisk(async () => file);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const response = await serveFile(disk, 'a.txt', ranged('bytes=1-3', { 'if-range': OLD_TEXT }), withRanges);
    expect(response.status).toBe(206);
    expect(reads).toEqual({ body: 1, size: 1, lastModified: 1, contentType: 1, acceptsRanges: 1, range: 1 });
    await response.arrayBuffer().catch(() => {});
  });

  it('a field that throws while the file is read cancels the body', async () => {
    for (const throws of ['size', 'lastModified', 'acceptsRanges'] as const) {
      const { disk, state } = counting({ throws });
      await expect(serveFile(disk, 'a.txt', get(), withRanges), throws).rejects.toThrow('is not readable');
      expect(state.cancelled, throws).toBe(1);
    }
  });

  it('a stale If-Range reopens a file that cannot be read: the error is thrown and the second body is cancelled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    for (const throws of ['size', 'acceptsRanges'] as const) {
      const first = slicing();
      const second = counting({ throws });
      let opened = 0;
      const disk = frameworkDisk(async (...args: unknown[]) => (++opened === 1 ? first.disk.open(args[0] as string, args[1] as never) : second.disk.open('a.txt')));
      await expect(serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': 'Mon, 01 Jan 2024 00:00:00 GMT' }), withRanges), throws).rejects.toThrow('is not readable');
      expect([first.state.cancelled, second.state.cancelled], throws).toEqual([1, 1]);
    }
  });

  it('a body that cannot become a response is cancelled', async () => {
    const { disk, state } = counting();
    await expect(serveFile(disk, 'a.txt', get(), withRanges)).rejects.toThrow('not a body');
    expect(state.cancelled).toBe(1);
  });

  it('a size that is a symbol is no length: the body goes out to its end, and is not an error', async () => {
    const disk = frameworkDisk(async () => ({ body: new Response('hello').body!, size: Symbol('size'), lastModified: OLD, contentType: 'text/plain' }));
    const response = await serveFile(disk, 'a.txt', get(), withRanges);
    expect([response.status, response.headers.get('content-length'), await response.text()]).toEqual([200, null, 'hello']);
  });

  it('a file whose time is no time is served whole: an If-Range cannot match it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { disk } = slicing({ lastModified: new Date(Number.NaN) });
    const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': 'Invalid Date' }), withRanges);
    expect([response.status, response.headers.get('content-range'), await response.text()]).toEqual([200, null, TEXT]);
    const other = slicing({ lastModified: new Date(Number.NaN) });
    const dated = await serveFile(other.disk, 'a.txt', ranged('bytes=2-4', { 'if-range': OLD_TEXT }), withRanges);
    expect([dated.status, await dated.text()]).toEqual([200, TEXT]);
  });
});

describe('more rows of the range rules', () => {
  const at = (time: Date) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(time);
  };

  it('a stale If-Range whose second open names a range anyway: the whole file, no 206', async () => {
    at(NOW);
    let opened = 0;
    const first = slicing();
    const disk = frameworkDisk(async (...args: unknown[]) => {
      if (++opened === 1) return first.disk.open(args[0] as string, args[1] as never);
      return { body: new Response(TEXT).body!, size: 10, lastModified: OLD, contentType: 'text/plain', range: { start: 2, end: 4 } };
    });
    const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-range': 'Mon, 01 Jan 2024 00:00:00 GMT' }), withRanges);
    expect([response.status, response.headers.get('content-range'), response.headers.get('content-length'), await response.text()]).toEqual([200, null, '10', TEXT]);
  });

  it('HEAD with If-Modified-Since is 304', async () => {
    const response = await serveFile(slicing().disk, 'a.txt', get({ 'if-modified-since': OLD_TEXT }, 'HEAD'), withRanges);
    expect([response.status, response.headers.get('accept-ranges')]).toEqual([304, 'bytes']);
  });

  it('a 304 of a disk that claims ranges has no Accept-Ranges without the option', async () => {
    const { disk, state } = slicing();
    const response = await serveFile(disk, 'a.txt', get({ 'if-modified-since': OLD_TEXT }), { cacheControl: 'private' });
    expect([response.status, response.headers.get('accept-ranges')]).toEqual([304, null]);
    expect(state.cancelled).toBe(1);
  });
});

describe('If-Match and If-Unmodified-Since', () => {
  const older = new Date(OLD.getTime() - 86_400_000).toUTCString();
  const later = new Date(OLD.getTime() + 86_400_000).toUTCString();

  it.each<[string, Record<string, string>]>([
    ['an entity tag', { 'if-match': '"abc"' }],
    ['a weak entity tag', { 'if-match': 'W/"abc"' }],
    ['a list that is not *', { 'if-match': '*, "abc"' }],
    ['an empty value', { 'if-match': '' }],
    ['a date older than the file', { 'if-unmodified-since': older }],
    ['an entity tag next to a date that holds', { 'if-match': '"abc"', 'if-unmodified-since': later }],
  ])('%s with a Range: 412 with no body, never cached, the safe headers, the body cancelled', async (_name, headers) => {
    const { disk, state } = slicing();
    const response = await serveFile(disk, 'a.html', ranged('bytes=2-4', headers), withRanges);
    expect([response.status, response.headers.get('content-length'), response.headers.get('cache-control'), response.headers.get('content-range'), await response.text()]).toEqual([412, '0', 'no-store', null, '']);
    expect(Object.fromEntries(response.headers)).toMatchObject({ 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'content-disposition': expect.stringMatching(/^attachment/) });
    expect(state.cancelled).toBe(1);
  });

  it.each<[string, Record<string, string>]>([
    ['*', { 'if-match': '*' }],
    ['a date the file did not outlive', { 'if-unmodified-since': OLD_TEXT }],
    ['a later date', { 'if-unmodified-since': later }],
    ['a date that does not parse', { 'if-unmodified-since': 'yesterday' }],
    ['* next to a date older than the file: If-Match decides', { 'if-match': '*', 'if-unmodified-since': older }],
  ])('%s passes: the range is answered', async (_name, headers) => {
    const response = await serveFile(slicing().disk, 'a.txt', ranged('bytes=2-4', headers), withRanges);
    expect([response.status, await response.text()]).toEqual([206, '234']);
  });

  it('a failing precondition comes before If-Modified-Since, and holds for HEAD', async () => {
    const both = await serveFile(slicing().disk, 'a.txt', ranged('bytes=2-4', { 'if-match': '"abc"', 'if-modified-since': OLD_TEXT }), withRanges);
    expect(both.status).toBe(412);
    const head = await serveFile(slicing().disk, 'a.txt', get({ 'if-match': '"abc"' }, 'HEAD'), withRanges);
    expect(head.status).toBe(412);
  });

  it('is not answered without the option, or for a disk that is not from Storage: today\'s response', async () => {
    const headers = { 'if-match': '"abc"', 'if-unmodified-since': older };
    const plain = await serveFile(slicing().disk, 'a.txt', ranged('bytes=2-4', headers), { cacheControl: 'private' });
    expect([plain.status, await plain.text()]).toEqual([200, TEXT]);
    const own = { open: async () => ({ body: new Response(TEXT).body!, size: 10, lastModified: OLD, contentType: 'text/plain' }) } as unknown as Disk;
    const other = await serveFile(own, 'a.txt', ranged('bytes=2-4', headers), withRanges);
    expect([other.status, await other.text()]).toEqual([200, TEXT]);
  });

  it('the file a stale If-Range reopens is checked against If-Unmodified-Since too: 412, the second body cancelled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const first = slicing();
    const second = slicing({ lastModified: new Date('2025-06-01T00:00:00Z') });
    let opened = 0;
    const disk = frameworkDisk(async (...args: unknown[]) => (++opened === 1 ? first.disk.open(args[0] as string, args[1] as never) : second.disk.open(args[0] as string)));
    const response = await serveFile(disk, 'a.txt', ranged('bytes=2-4', { 'if-unmodified-since': new Date('2025-03-01T00:00:00Z').toUTCString(), 'if-range': 'Mon, 01 Jan 2024 00:00:00 GMT' }), withRanges);
    expect([response.status, response.headers.get('content-length'), response.headers.get('cache-control'), await response.text()]).toEqual([412, '0', 'no-store', '']);
    expect([first.state.cancelled, second.state.cancelled]).toEqual([1, 1]);
  });
});
