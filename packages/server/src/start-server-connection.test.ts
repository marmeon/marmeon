import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createApplication, Logger, type Container, type LogContext } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, json, Router, view } from '@marmeon/http';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { startServer } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const logged: { message: string; context: LogContext }[] = [];
class MemoryLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(message: string, context: LogContext = {}): void {
    logged.push({ message, context });
  }
  child(): Logger {
    return this;
  }
}
class LoggingProvider {
  register(container: Container) {
    container.singleton(Logger, () => new MemoryLogger());
  }
}

let root: string;
beforeAll(() => {
  root = tempDir('marmeon-serve-connection-');
  for (const dir of ['dist/client', 'dist/server', 'node_modules']) mkdirSync(join(root, dir), { recursive: true });
  const template = '<html><head><!--app-head--></head><body><!--app-html--></body></html>';
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'index.html'), template);
  writeFileSync(join(root, 'dist/client/index.html'), template);
  writeFileSync(join(root, 'ssr.ts'), 'export const render = async () => ({ html: "" });');
  writeFileSync(join(root, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "" });');
  symlinkSync(dirname(createRequire(import.meta.url).resolve('vite/package.json')), join(root, 'node_modules/vite'), 'dir');
});

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Mode = 'development' | 'production';

async function serve(mode: Mode, before?: (response: ServerResponse) => void) {
  let cancel!: () => void;
  const cancelled = new Promise<void>((resolve) => (cancel = resolve));
  let release!: () => void;
  const fileClosed = new Promise<void>((resolve) => (release = resolve));
  let gone!: () => void;
  const clientGone = new Promise<void>((resolve) => (gone = resolve));
  let socket: Socket;
  let produce!: (controller: ReadableStreamDefaultController<Uint8Array>) => void;
  const produced = new Promise<ReadableStreamDefaultController<Uint8Array>>((resolve) => (produce = resolve));
  const decoded = Buffer.from('DECODED '.repeat(100));
  const encoded = gzipSync(decoded);
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': encoded.byteLength, 'content-type': 'text/plain' });
    response.end(encoded);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    upstream.closeAllConnections();
    return new Promise((resolve) => upstream.close(resolve));
  });
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/`;
  // Made before startServer, so before the adapter's own Response is the global one.
  const early = new Response('EARLY', { status: 403 });
  class Mine extends Response {}
  // What a module's middleware returns for every request.
  let Platform: typeof Response = Response;
  while (Object.getPrototypeOf(Platform) !== Function.prototype) Platform = Object.getPrototypeOf(Platform);
  const gate = new Platform('no', { status: 403 });
  class Gate {
    async handle(_ctx: unknown, next: () => Promise<Response>) {
      await next();
      return gate;
    }
  }
  const app = await createApplication({ root, discover: false, providers: [LoggingProvider, EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider] }, {
    env: { APP_KEY: generateKey(), APP_URL: 'http://app.example', LOG_LEVEL: 'silent' },
    override: (container) =>
      container.make(Router).load(openRoutes((Route) => {
        Route.get('/first', () => fileClosed.then(() => 'FIRST'));
        Route.get('/second', () => 'SECOND');
        Route.get('/fetched', async () => {
          const fetched = await fetch(upstreamUrl);
          return new Response(fetched.body, fetched);
        });
        Route.get('/drains', () => {
          let chunks = 0;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (chunks++ < 4) controller.enqueue(new Uint8Array(128 * 1024).fill(97));
                else controller.error(new Error('FAILURE-TEXT'));
              },
            }, { highWaterMark: 1 }),
          );
        });
        Route.get('/closed-early', () => {
          const body = new ReadableStream({
            pull: (controller) => controller.error(Object.assign(new Error('closed early'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })),
          }, { highWaterMark: 0 });
          return new Response(body);
        });
        Route.get('/early', () => early);
        Route.middleware(Gate as never).get('/gate', () => 'x');
        Route.get('/subclass', () => new Mine('SUBCLASS', { status: 401 }));
        Route.get('/clone', () => new Response('CLONE', { status: 503 }).clone());
        Route.get('/json', () => Response.json({ own: true }, { status: 202 }));
        Route.get('/redirect', () => Response.redirect('http://localhost/second', 302));
        Route.get('/manual', () => new Response(null, { status: 302, headers: { location: '/second' } }));
        Route.get('/no-content', () => new Response(null, { status: 204 }));
        Route.get('/not-modified', () => new Response(null, { status: 304 }));
        Route.get('/upstream', () => fetch(upstreamUrl));
        Route.get('/upstream-clone', async () => (await fetch(upstreamUrl)).clone());
        Route.get('/error', () => Response.error());
        Route.get('/used', async () => {
          const used = new Response('USED');
          await used.text();
          return used;
        });
        // A length that is not the body's, from the helpers an app uses.
        Route.get('/json-long', () => json({ a: 'SURPLUS-SURPLUS' }, { headers: { 'content-length': '5' } }));
        Route.get('/json-short', () => json({ a: 1 }, { headers: { 'content-length': '500' } }));
        Route.get('/view-long', () => view('Home' as never, {}, { headers: { 'content-length': '5' } }));
        Route.get('/view-short', () => view('Home' as never, {}, { headers: { 'content-length': '50000' } }));
        // An app's producer: it has no cancel() of its own, so its controller must stay open.
        Route.get('/produced', () => new Response(new ReadableStream({ start: produce })));
        Route.get('/file', () => {
          let next = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (next++ < 4) controller.enqueue(new TextEncoder().encode('a'));
              else controller.error(new Error('early end'));
            },
          }, { highWaterMark: 0 });
          return new Response(body, { headers: { 'content-length': '10' } });
        });
        Route.get('/released', () => new Response(Object.assign(new ReadableStream({ cancel: () => cancel() }), { [Symbol.for('marmeon.body.release')]: true })));
        Route.get('/left', async () => {
          socket.destroy();
          await clientGone;
          return new Response(new ReadableStream({ cancel: () => cancel() }));
        });
      })),
  });
  const running = await startServer({ app, ssrEntry: 'ssr.ts', host: '127.0.0.1', port: 0, mode });
  cleanups.push(() => app.shutdown(), () => running.close({ immediately: true }));
  running.server.on('connection', (connection) => connection.once('close', gone));
  running.server.prependListener('request', (request, response) => {
    if (request.url === '/file') response.once('close', release);
    if (request.url === '/second') before?.(response);
  });
  socket = connect((running.server.address() as AddressInfo).port, '127.0.0.1');
  socket.on('error', () => {});
  cleanups.push(() => socket.destroy());
  let received = '';
  socket.on('data', (data) => (received += data.toString('latin1')));
  return { socket, cancelled, produced, closed: new Promise<void>((resolve) => socket.on('close', () => resolve())), received: () => received };
}

// localhost: Vite's development server refuses a host it does not know.
const get = (path: string, method = 'GET') => `${method} ${path} HTTP/1.1\r\nhost: localhost\r\n\r\n`;

describe.each(['production', 'development'] as const)('startServer in %s', (mode) => {
  it('a failed body behind another response takes the connection along', async () => {
    const client = await serve(mode);
    client.socket.write(get('/first') + get('/file') + get('/second'));
    await client.closed;
    expect(client.received().endsWith('FIRST')).toBe(true);
  });

  it('a gzip answer of fetch() is cut at the length it announces, and the following request is answered intact', async () => {
    const client = await serve(mode);
    client.socket.write(get('/fetched') + get('/second'));
    // Whichever comes first decides, so it is no wait for a time.
    const answered = new Promise<void>((resolve) => client.socket.on('data', () => client.received().includes('SECOND') && resolve()));
    await Promise.race([client.closed, answered]);
    const response = client.received();
    const body = response.slice(response.indexOf('\r\n\r\n') + 4);
    const length = Number(/content-length: (\d+)/i.exec(response)![1]);
    expect(body.slice(length)).toMatch(/^HTTP\/1\.1 200 [^]*SECOND$/);
  });

  it('a body that fails while the socket drains sends no text of the error', async () => {
    const client = await serve(mode);
    client.socket.write(get('/drains'));
    await client.closed;
    expect(client.received()).toContain('HTTP/1.1 200');
    expect(client.received()).not.toContain('FAILURE-TEXT');
  });

  it('a body that failed as closed early before the headers is answered', async () => {
    const client = await serve(mode);
    client.socket.write(get('/closed-early') + get('/second'));
    while (!client.received().includes('SECOND')) await new Promise((resolve) => client.socket.once('data', resolve));
    expect(client.received()).toMatch(/^HTTP\/1\.1 500 /);
    expect(client.received()).not.toContain('Error:');
  });

  it('HEAD of that answer keeps the connection', async () => {
    const client = await serve(mode);
    client.socket.write(get('/fetched', 'HEAD') + get('/second'));
    while (!client.received().includes('SECOND')) await new Promise((resolve) => client.socket.once('data', resolve));
    expect(client.socket.destroyed).toBe(false);
  });

  it('HEAD cancels a body that says it can be released', async () => {
    const client = await serve(mode);
    client.socket.write(get('/released', 'HEAD'));
    await client.cancelled;
  });

  it('a HEAD after a GET that read the whole body of a Response a module made once answers 403', async () => {
    const client = await serve(mode);
    client.socket.write(get('/gate'));
    while (!client.received().endsWith('no\r\n0\r\n\r\n')) await new Promise((resolve) => client.socket.once('data', resolve));
    client.socket.write(get('/gate', 'HEAD') + get('/second'));
    while (!client.received().includes('SECOND')) await new Promise((resolve) => client.socket.once('data', resolve));
    expect(client.received().match(/HTTP\/1\.1 403 /g)).toHaveLength(2);
  });

  it('a listener that rejects ends the connection, and startServer logs it', async () => {
    logged.length = 0;
    // Its own answer fails too, so the adapter's listener rejects.
    const client = await serve(mode, (response) => {
      response.writeHead = () => {
        throw new Error('WRITE-HEAD-FAILED');
      };
    });
    client.socket.write(get('/second'));
    await client.closed;
    expect(client.received()).toBe('');
    expect(logged.map((entry) => entry.message)).toContain('The server could not answer a request');
    expect(JSON.stringify(logged)).toContain('WRITE-HEAD-FAILED');
  });

  it('HEAD leaves a stream of the app alone', async () => {
    const client = await serve(mode);
    client.socket.write(get('/produced', 'HEAD') + get('/second'));
    const producer = await client.produced;
    while (!client.received().includes('SECOND')) await new Promise((resolve) => client.socket.once('data', resolve));
    expect(() => producer.enqueue(new Uint8Array(1))).not.toThrow();
    producer.close();
  });

  async function answer(path: string, extra = '') {
    const client = await serve(mode);
    client.socket.write(get(path).replace('\r\n\r\n', `\r\nconnection: close\r\n${extra}\r\n`));
    await client.closed;
    return client.received();
  }

  it.each([
    ['one made before startServer', '/early', 403, 'EARLY'],
    ['a subclass', '/subclass', 401, 'SUBCLASS'],
    ['a clone of an own one', '/clone', 503, 'CLONE'],
    ['Response.json()', '/json', 202, '{"own":true}'],
    ['Response.redirect()', '/redirect', 302, ''],
    ['a manual redirect', '/manual', 302, ''],
    ['a 204', '/no-content', 204, ''],
    ['a 304', '/not-modified', 304, ''],
  ] as const)('a route that returns %s: it goes out as it is', async (_name, path, status, body) => {
    const received = await answer(path);
    expect(received).toContain(`HTTP/1.1 ${status} `);
    if (body !== '') expect(received).toContain(body);
  });

  it.each([
    ['a Response of fetch()', '/upstream'],
    ['a clone of one', '/upstream-clone'],
    ['Response.error()', '/error'],
    ['a Response whose body is used', '/used'],
  ] as const)('a route that returns %s: it is refused with a 500 before any header', async (_name, path) => {
    const received = await answer(path);
    expect(received).toContain('HTTP/1.1 500 ');
    expect(received).not.toContain('DECODED');
    expect(received).not.toContain('USED');
    expect(received).not.toMatch(/content-encoding/i);
  });

  it.each([
    ['json() longer than its length', '/json-long', 'cut'],
    ['json() shorter than its length', '/json-short', 'closed'],
    ['view() longer than its length', '/view-long', 'cut'],
    ['view() shorter than its length', '/view-short', 'closed'],
  ] as const)('%s: a pipelined next request is not read as its body', async (_name, path, outcome) => {
    const client = await serve(mode);
    client.socket.write(get(path) + get('/second'));
    const answered = new Promise<void>((resolve) => client.socket.on('data', () => client.received().includes('SECOND') && resolve()));
    await Promise.race([client.closed, answered]);
    const received = client.received();
    if (outcome === 'closed') {
      expect(received).not.toContain('SECOND');
      return;
    }
    const length = Number(/content-length: (\d+)/i.exec(received)![1]);
    const body = received.slice(received.indexOf('\r\n\r\n') + 4);
    expect(length).toBe(5);
    expect(body.slice(5)).toMatch(/^HTTP\/1\.1 200 [^]*SECOND$/);
  });

  it('cancels the body when the client went before the response', async () => {
    const client = await serve(mode);
    client.socket.write(get('/left'));
    await client.cancelled;
  });
});
