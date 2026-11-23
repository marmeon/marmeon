import { TestClock } from '@marmeon/core/testing';
import { describe, expect, it } from 'vitest';
import { FakeS3 } from './__fixtures__/s3-fake.ts';
import type { Disk } from './disk.ts';
import { S3Disk } from './drivers/s3.ts';
import { serveFile } from './serve.ts';
import { lengthOf } from './size.ts';

/** Against the in-memory fake of the SDK: no service. */
describe('the s3 disk against a store that names no length', () => {
  const fake = () => {
    const store = new FakeS3();
    const disk = new S3Disk({ name: 'files', options: { driver: 's3', bucket: 'b', region: 'us-east-1', endpoint: 'http://store.test', credentials: { accessKeyId: 'a', secretAccessKey: 's' }, root: '', visibility: 'private' }, visibility: 'private', clock: new TestClock(), load: store.load });
    return { store, disk };
  };
  const text = async (body: ReadableStream<Uint8Array>) => new Response(body).text();
  const request = () => new Request('http://localhost/a.txt');

  it('open() and size() still answer 0, and serveFile() sends the whole body without a length', async () => {
    const { store, disk } = fake();
    await disk.put('a.txt', 'hello');
    store.withoutLength = true;
    const opened = await disk.open('a.txt');
    expect(opened.size).toBe(0);
    expect(lengthOf(opened)).toBeUndefined();
    expect(await text(opened.body)).toBe('hello');
    expect(await disk.size('a.txt')).toBe(0);
    expect((await disk.fingerprint('a.txt')).size).toBe(0);
    const response = await serveFile(disk, 'a.txt', request(), { cacheControl: 'private' });
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.text()).toBe('hello');
  });

  it('a disk around this one that rebuilds the file by its fields still sends the whole body without a length', async () => {
    const { store, disk } = fake();
    await disk.put('a.txt', 'hello');
    store.withoutLength = true;
    const around = {
      open: async (key: string) => {
        const { body, size, lastModified, contentType } = await disk.open(key);
        return { body, size, lastModified, contentType };
      },
    } as unknown as Disk;
    const response = await serveFile(around, 'a.txt', request(), { cacheControl: 'private' });
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.text()).toBe('hello');
  });

  it('a disk around this one that knows the size sets it and is believed', async () => {
    const { store, disk } = fake();
    await disk.put('a.txt', 'hello');
    store.withoutLength = true;
    const around = { open: async (key: string) => ({ ...(await disk.open(key)), size: 5 }) } as unknown as Disk;
    const response = await serveFile(around, 'a.txt', request(), { cacheControl: 'private' });
    expect(response.headers.get('content-length')).toBe('5');
    expect(await response.text()).toBe('hello');
  });

  it('the members that need no length work', async () => {
    const { store, disk } = fake();
    await disk.put('a.txt', 'hello');
    store.withoutLength = true;
    expect(await text(await disk.stream('a.txt'))).toBe('hello');
    expect(new TextDecoder().decode(await disk.get('a.txt'))).toBe('hello');
    expect(await disk.text('a.txt')).toBe('hello');
    expect(await disk.exists('a.txt')).toBe(true);
    expect(await disk.mimeType('a.txt')).toBe('text/plain');
    expect(await disk.lastModified('a.txt')).toBeInstanceOf(Date);
    const etag = store.objects.get('b/a.txt')!.etag;
    expect(await text(await disk.streamIfMatch('a.txt', etag))).toBe('hello');
    expect(await disk.delete('a.txt')).toBe(true);
  });

  it('a real length of 0 is an empty file that announces Content-Length: 0', async () => {
    const { disk } = fake();
    await disk.put('empty.txt', '');
    expect(await disk.size('empty.txt')).toBe(0);
    expect((await disk.fingerprint('empty.txt')).size).toBe(0);
    const opened = await disk.open('empty.txt');
    expect(opened.size).toBe(0);
    expect(await text(opened.body)).toBe('');
    const response = await serveFile(disk, 'empty.txt', request(), { cacheControl: 'private' });
    expect(response.headers.get('content-length')).toBe('0');
  });
});
