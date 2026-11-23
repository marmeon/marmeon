import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { createApplication } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, Router } from '@marmeon/http';
import { ServerServiceProvider, startServer, type RunningServer } from '@marmeon/server';
import type { FileHandle } from 'node:fs/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import type { Disk } from './disk.ts';
import { LocalDisk } from './drivers/local.ts';
import { S3Disk } from './drivers/s3.ts';
import { FakeS3 } from './__fixtures__/s3-fake.ts';
import { TestClock } from '@marmeon/core/testing';
import { serveFile } from './serve.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

// What a disk opened. Holding a handle does not hold its stream.
const opened = vi.hoisted(() => [] as FileHandle[]);
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      opened.push(handle);
      return handle;
    },
  };
});

let root: string;
beforeAll(() => {
  root = tempDir('marmeon-connection-');
  for (const dir of ['dist/client', 'dist/server', 'files']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'dist/client/index.html'), '<html><head><!--app-head--></head><body><!--app-html--></body></html>');
  writeFileSync(join(root, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "" });');
});

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(disk: Disk) {
  let release!: () => void;
  const fileClosed = new Promise<void>((resolve) => (release = resolve));
  const app = await createApplication({ root, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider] }, {
    env: { APP_KEY: generateKey(), APP_URL: 'http://app.example', LOG_LEVEL: 'silent' },
    override: (container) =>
      container.make(Router).load(openRoutes((Route) => {
        Route.get('/own', async () => new Response(await disk.stream('a.txt')));
        Route.get('/file', (ctx) => serveFile(disk, 'a.txt', ctx.request, { cacheControl: 'no-store' }));
        // It holds its place until the file's response was destroyed: so that one is queued, whatever the timing.
        Route.get('/first', () => fileClosed.then(() => 'FIRST'));
        Route.get('/second', () => 'SECOND');
      })),
  });
  const running: RunningServer = await startServer({ app, host: '127.0.0.1', port: 0, mode: 'production' });
  cleanups.push(() => app.shutdown(), () => running.close({ immediately: true }));
  running.server.prependListener('request', (request, response) => {
    if (request.url !== '/file') return;
    response.once('close', release);
    const { end } = response;
    response.end = ((...args: unknown[]) => {
      const ended = Reflect.apply(end, response, args);
      release();
      return ended;
    }) as typeof end;
  });
  const socket: Socket = connect((running.server.address() as AddressInfo).port, '127.0.0.1');
  socket.on('error', () => {});
  cleanups.push(() => socket.destroy());
  let received = '';
  socket.on('data', (data) => (received += data.toString('latin1')));
  return { socket, closed: new Promise<void>((resolve) => socket.on('close', () => resolve())), received: () => received };
}

const get = (path: string) => `GET ${path} HTTP/1.1\r\nhost: app.example\r\n\r\n`;
const driver = (size: number, chunks: string[], failure?: Error): Disk =>
  ({
    name: 'test',
    open: async () => ({
      size,
      lastModified: new Date(0),
      contentType: 'text/plain',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          if (failure) controller.error(failure);
          else controller.close();
        },
      }),
    }),
  }) as unknown as Disk;

const local = () => new LocalDisk({ name: 'files', root: join(root, 'files'), visibility: 'private', temporaryUrls: { sign: () => '' } });
const truncated = (size: number, to: number): Disk =>
  ({
    open: async () => {
      const path = join(root, 'files', 'a.txt');
      writeFileSync(path, Buffer.alloc(size, 97));
      const file = await local().open('a.txt');
      truncateSync(path, to);
      return file;
    },
  }) as unknown as Disk;

describe('serveFile on startServer', () => {
  it.each([
    ['a driver with no bytes', () => driver(10, [])],
    ['a driver that is short at once', () => driver(10, ['hello'])],
    ['a driver whose first read fails as closed early', () => driver(10, [], Object.assign(new Error('closed early'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }))],
    ['a local file truncated to nothing', () => truncated(10, 0)],
    ['a local file truncated', () => truncated(10, 5)],
  ] as const)('%s is a failed response, the first and a queued one', async (_case, disk) => {
    for (const before of ['', get('/first')]) {
      const client = await serve(disk());
      client.socket.write(before + get('/file') + get('/second'));
      const answered = new Promise<void>((resolve) => client.socket.on('data', () => client.received().includes('SECOND') && resolve()));
      await Promise.race([client.closed, answered]);
      expect(client.received()).not.toContain('Error:');
      if (before !== '') expect(client.received()).toContain('FIRST');
      // A following answer comes only behind a whole 500, never inside a body that announced more.
      if (client.received().includes('SECOND')) expect(client.received()).toMatch(/HTTP\/1\.1 500 [^]*SECOND$/);
      else await client.closed;
    }
  });

  it('a local file that grew is cut and the next response follows intact', async () => {
    const path = join(root, 'files', 'a.txt');
    const client = await serve({
      open: async () => {
        writeFileSync(path, 'hello');
        const file = await local().open('a.txt');
        appendFileSync(path, 'SURPLUS');
        return file;
      },
    } as unknown as Disk);
    client.socket.write(get('/file') + get('/second'));
    while (!client.received().includes('SECOND')) await new Promise((resolve) => client.socket.once('data', resolve));
    expect(client.received()).not.toContain('SURPLUS');
    expect(client.received()).toContain('\r\n\r\nhelloHTTP/1.1 200');
  });

  it('HEAD of a route that streams from a local disk closes the file', async () => {
    const path = join(root, 'files', 'a.txt');
    writeFileSync(path, 'hello');
    opened.length = 0;
    const client = await serve(local());
    client.socket.write(get('/own').replace('GET', 'HEAD'));
    await vi.waitFor(() => {
      expect(opened).toHaveLength(1);
      expect(opened[0]!.fd).toBe(-1);
    });
  });

  it('HEAD of a route that streams from S3 cancels the body', async () => {
    const store = new FakeS3();
    const disk = new S3Disk({ name: 'files', options: { driver: 's3', bucket: 'b', region: 'us-east-1', endpoint: 'http://store.test', credentials: { accessKeyId: 'a', secretAccessKey: 's' }, root: '', visibility: 'private' }, visibility: 'private', clock: new TestClock(), load: store.load });
    // More than one chunk, so the stream is not closed before it is cancelled.
    await disk.put('a.txt', new Uint8Array(300 * 1024));
    const client = await serve(disk);
    client.socket.write(get('/own').replace('GET', 'HEAD'));
    await vi.waitFor(() => expect(store.cancelled).toBe(1));
  });

  it('a longer body is cut and the next response follows intact', async () => {
    const client = await serve(driver(5, ['hello', 'SURPLUS']));
    client.socket.write(get('/file') + get('/second'));
    while (!client.received().includes('SECOND')) await new Promise((resolve) => client.socket.once('data', resolve));
    expect(client.received()).not.toContain('SURPLUS');
    expect(client.received()).toContain('\r\n\r\nhelloHTTP/1.1 200');
  });
});

describe('the body of a local disk', () => {
  it('closes its file when it was dropped without a cancel', async () => {
    const path = join(root, 'files', 'a.txt');
    writeFileSync(path, 'hello');
    opened.length = 0;
    await (async () => void (await local().open('a.txt')))();
    setFlagsFromString('--expose-gc');
    const collect = runInNewContext('gc') as () => void;
    await vi.waitFor(() => {
      collect();
      expect(opened.map((handle) => handle.fd)).toEqual([-1]);
    });
  });

  it('closes its file when a read fails', async () => {
    writeFileSync(join(root, 'files', 'a.txt'), 'hello');
    opened.length = 0;
    const file = await local().open('a.txt');
    vi.spyOn(opened[0]!, 'read').mockRejectedValue(new Error('EIO'));
    await expect(file.body.getReader().read()).rejects.toThrow('EIO');
    expect(opened[0]!.fd).toBe(-1);
  });

  it('takes a cancel during a read', async () => {
    writeFileSync(join(root, 'files', 'a.txt'), 'hello');
    const reader = (await local().open('a.txt')).body.getReader();
    const read = reader.read();
    await reader.cancel();
    expect((await read).done).toBe(true);
  });

  it("gives a chunk whose buffer holds the file's bytes alone", async () => {
    writeFileSync(join(root, 'files', 'a.txt'), 'hello');
    const { value } = await (await local().open('a.txt')).body.getReader().read();
    expect(new TextDecoder().decode(value!.buffer)).toBe('hello');
  });
});
