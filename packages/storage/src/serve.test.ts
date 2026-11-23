import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { freshDirectory, recordingUrls, removeDirectories } from './__fixtures__/disks.ts';
import { LocalDisk } from './drivers/local.ts';
import type { Disk, OpenedFile } from './disk.ts';
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
