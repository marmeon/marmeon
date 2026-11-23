import { getRequestListener } from '@hono/node-server';
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { guarded } from './response-guard.ts';

const shapes: readonly (readonly [string, (response: Response) => Response])[] = [
  ['an untouched response', (response) => response],
  ['a response whose body was read', (response) => (void response.body, response)],
];
const get = (path: string) => `GET ${path} HTTP/1.1\r\nhost: x\r\n\r\n`;
const announced = (body: ReadableStream<Uint8Array>, length: number) => new Response(body, { headers: { 'content-length': String(length) } });
/** `chunks`, then the failure, with nothing read ahead and nothing waited for. */
const failing = (chunks: readonly string[], reason: unknown) => {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk === undefined) controller.error(reason);
      else controller.enqueue(new TextEncoder().encode(chunk));
    },
  }, { highWaterMark: 0 });
};
/** 128 KiB chunks with a stream that reads ahead: it fails while the adapter waits for the socket to drain. */
const readsAhead = (reason: Error) => {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next++ < 4) controller.enqueue(new Uint8Array(128 * 1024).fill(97));
      else controller.error(reason);
    },
  });
};

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function serve(file: () => Response, before?: (response: ServerResponse) => void) {
  let release!: () => void;
  const fileClosed = new Promise<void>((resolve) => (release = resolve));
  const listener = guarded(getRequestListener((request) => {
    const path = new URL(request.url).pathname;
    // The response before the file's holds its place until the file's was ended or destroyed: so that is queued, whatever the timing.
    if (path === '/first') return fileClosed.then(() => new Response('FIRST'));
    return path === '/second' ? new Response('SECOND') : file();
  }));
  const server = createServer((request, response) => {
    if (request.url === '/file') {
      response.once('close', release);
      const { end } = response;
      response.end = ((...args: unknown[]) => {
        const ended = Reflect.apply(end, response, args);
        release();
        return ended;
      }) as typeof end;
      before?.(response);
    }
    return listener(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
  sockets.push(socket);
  socket.on('error', () => {});
  let received = '';
  socket.on('data', (data) => (received += data.toString('latin1')));
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  const answered = new Promise<void>((resolve) => socket.on('data', () => received.includes('SECOND') && resolve()));
  return { socket, closed, settled: () => Promise.race([closed, answered]), received: () => received };
}

describe.each(shapes)('a failed body, for %s', (name, shape) => {
  const cases: readonly (readonly [string, () => Response])[] = [
    ['no byte', () => announced(failing([], new Error('early end')), 10)],
    ['5 of 10 bytes', () => announced(failing(['hello'], new Error('early end')), 10)],
    ['after the headers', () => announced(failing(['a', 'b', 'c', 'd'], new Error('early end')), 10)],
  ];
  it.each(cases)('%s: behind another it takes the connection along, or is a whole 500 without a text', async (failed, make) => {
    const client = await serve(() => shape(make()));
    client.socket.write(get('/first') + get('/file') + get('/second'));
    await client.closed;
    const after = client.received().slice(client.received().indexOf('FIRST') + 'FIRST'.length);
    expect(client.received()).toContain('FIRST');
    expect(after).not.toContain('early end');
    // Untouched, the headers of the file are out before it fails: the connection goes. Touched, a failure on the first read is a whole 500 that goes out.
    const wholeError = name.includes('was read') && failed !== 'after the headers';
    if (wholeError) expect(after).toMatch(/^HTTP\/1\.1 500 [^]*\r\n\r\n0\r\n\r\n$/);
    else expect(after).toBe('');
  });

  it('answers a body that failed as closed early before the headers', async () => {
    const client = await serve(() => shape(announced(failing([], Object.assign(new Error('closed early'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })), 10)));
    client.socket.write(get('/file') + get('/second'));
    await (name.includes('was read') ? client.settled() : client.closed);
    expect(client.received()).not.toContain('closed early');
    // Untouched, the headers are out and the connection goes. Touched, none are, and the answer is a whole 500 that the next response follows.
    if (name.includes('was read')) {
      expect(client.received()).toMatch(/^HTTP\/1\.1 500 [^]*content-length: 0\r\n[^]*SECOND/);
    } else {
      await client.closed;
      expect(client.received()).not.toContain('SECOND');
    }
  });

  it.each(cases)('%s: the first response takes it along too', async (_case, make) => {
    const client = await serve(() => shape(make()));
    client.socket.write(get('/file') + get('/second'));
    await client.closed;
    expect(client.received()).not.toContain('SECOND');
  });

  it('writes no error text after bytes, for a failure without a reason', async () => {
    const client = await serve(() => shape(announced(failing(['a', 'b', 'c', 'd'], undefined), 100)));
    client.socket.write(get('/file'));
    await client.closed;
    expect(client.received()).not.toContain('Error:');
  });

  it('writes no error text after bytes, for a body of no announced length', async () => {
    const client = await serve(() => shape(new Response(failing(['a', 'b', 'c', 'd'], new Error('FAILURE-TEXT')))));
    client.socket.write(get('/file'));
    await client.closed;
    expect(client.received()).not.toContain('FAILURE-TEXT');
    expect(client.received()).not.toContain('Error:');
  });

  it('writes no error text when the body fails while the socket drains', async () => {
    const client = await serve(() => shape(announced(readsAhead(new Error('FAILURE-TEXT')), 4 * 128 * 1024 + 1)));
    client.socket.write(get('/file'));
    await client.closed;
    expect(client.received()).not.toContain('FAILURE-TEXT');
  });

  it.each([
    ['announced', { 'content-length': '10' }],
    ['of no announced length', { 'content-type': 'text/csv' }],
  ] as const)('sends no text when a body %s fails on its first read', async (_case, headers) => {
    // A header set before the adapter's, as a draining server and Vite set them: Node then takes the other way through writeHead().
    for (const before of [undefined, (response: ServerResponse) => void response.setHeader('vary', 'Origin')]) {
      const client = await serve(() => shape(new Response(failing([], new Error('FAILURE-TEXT')), { headers })), before);
      client.socket.write(get('/file'));
      await client.closed;
      expect(client.received()).not.toContain('FAILURE-TEXT');
      expect(client.received()).not.toContain('Error:');
    }
  });

  it.each([
    ['in one chunk', ['helloSURPLUS']],
    ['in a later chunk', ['hello', 'SURPLUS']],
    ['after the headers', ['h', 'e', 'l', 'l', 'o', 'SURPLUS']],
  ] as const)('cuts at the announced length and keeps the connection, surplus %s', async (_case, chunks) => {
    for (const before of ['', get('/first')]) {
      let next = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[next++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(chunk));
        },
      }, { highWaterMark: 0 });
      const client = await serve(() => shape(announced(body, 5)));
      client.socket.write(before + get('/file') + get('/second'));
      await client.settled();
      expect(client.received()).not.toContain('SURPLUS');
      expect(client.received()).toContain('\r\n\r\nhelloHTTP/1.1 200');
      expect(client.received()).toContain('SECOND');
      if (before !== '') expect(client.received()).toContain('FIRST');
    }
  });

  it.each([
    ['with no byte', []],
    ['with 5 of 10 bytes', ['hello']],
    ['after the headers', ['a', 'b', 'c', 'd']],
  ] as const)('takes the connection along for a body that closes short %s', async (_case, chunks) => {
    for (const before of ['', get('/first')]) {
      let next = 0;
      // No error: as a wrapper that swallows one, and a file that was truncated.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[next++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(chunk));
        },
      }, { highWaterMark: 0 });
      const client = await serve(() => shape(announced(body, 10)));
      client.socket.write(before + get('/file') + get('/second'));
      await client.closed;
      expect(client.received()).not.toContain('SECOND');
      if (before !== '') expect(client.received()).toContain('FIRST');
    }
  });

  it.each([204, 304, 200])('keeps the connection of a response without a body that names a length, %s', async (status) => {
    const client = await serve(() => shape(new Response(status === 200 ? new Blob(['hello']).stream() : null, { status, headers: { 'content-length': '5' } })));
    client.socket.write((status === 200 ? get('/file').replace('GET', 'HEAD') : get('/file')) + get('/second'));
    await client.settled();
    expect(client.received()).toContain('SECOND');
    expect(client.socket.destroyed).toBe(false);
  });

  it('keeps a pipelined connection for bodies of their length', async () => {
    const body = () => new Blob(['hello']).stream();
    const client = await serve(() => shape(announced(body(), 5)));
    client.socket.write(get('/file') + get('/second'));
    while (!client.received().endsWith('SECOND')) await new Promise((resolve) => client.socket.once('data', resolve));
    expect(client.received()).toContain('\r\n\r\nhelloHTTP/1.1 200');
    expect(client.socket.destroyed).toBe(false);
  });
});

it.each([
  ['no headers', () => new Response('WHOLE')],
  ['a status of 500', () => new Response('WHOLE', { status: 500 })],
  ['headers', () => new Response('WHOLE', { headers: { 'content-type': 'text/plain' } })],
  ['chunked by hand', () => new Response('WHOLE', { headers: { 'transfer-encoding': 'chunked' } })],
] as const)('keeps a whole body with %s, also after a header set before', async (_case, make) => {
  for (const before of [undefined, (response: ServerResponse) => void response.setHeader('vary', 'Origin')]) {
    const client = await serve(make, before);
    client.socket.write(get('/file') + get('/second'));
    while (!client.received().includes('SECOND')) await new Promise((resolve) => client.socket.once('data', resolve));
    expect(client.received()).toContain('WHOLE');
    expect(client.socket.destroyed).toBe(false);
  }
});

it('keeps a whole body whose length a layer above takes off', async () => {
  // What a compressing middleware of Node's does in writeHead(): the body is then chunked.
  const client = await serve(() => new Response('WHOLE', { status: 500, headers: new Headers({ 'content-type': 'text/plain' }) }), (response) => {
    const { writeHead } = response;
    response.writeHead = ((status: number, headers?: Record<string, unknown>) => {
      for (const [name, value] of Object.entries(headers ?? {})) {
        if (name.toLowerCase() !== 'content-length') response.setHeader(name, value as string);
      }
      response.removeHeader('content-length');
      return Reflect.apply(writeHead, response, [status]);
    }) as typeof writeHead;
  });
  client.socket.write(get('/file') + get('/second'));
  await client.settled();
  expect(client.received()).toContain('WHOLE');
  expect(client.received()).toContain('SECOND');
});

it('writes no error text after the headers alone, for a failure without a reason', async () => {
  // Only the untouched response has its headers out before the first read.
  const client = await serve(() => announced(failing([], undefined), 20));
  client.socket.write(get('/file'));
  await client.closed;
  expect(client.received()).not.toContain('Error:');
});

/** A server of its own listener, for what a `Response` cannot say: a status below 200, a listener that rejects. */
async function listen(listener: (request: Parameters<RequestListener>[0], response: ServerResponse) => unknown) {
  const server = createServer((request, response) => void listener(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
  sockets.push(socket);
  socket.on('error', () => {});
  let received = '';
  socket.on('data', (data) => (received += data.toString('latin1')));
  return { socket, closed: new Promise<void>((resolve) => socket.on('close', () => resolve())), received: () => received };
}

const bodyOf = (text: string) => new Blob([text]).stream();
const announcedAs = (text: string, length: string, shape: (response: Response) => Response, extra: Record<string, string> = {}) =>
  shape(new Response(bodyOf(text), { headers: { 'content-length': length, ...extra } }));

describe.each(shapes)('a body whose length is wrong in end(chunk), for %s', (_name, shape) => {
  it.each([
    ['longer', 'helloSURPLUS', '5'],
    ['longer by one byte', 'hello!', '5'],
  ] as const)('cuts a body that is %s than its length and keeps the connection', async (_case, text, length) => {
    for (const before of ['', get('/first')]) {
      const client = await serve(() => shape(new Response(text, { headers: { 'content-length': length } })));
      client.socket.write(before + get('/file') + get('/second'));
      await client.settled();
      expect(client.received()).not.toContain('SURPLUS');
      expect(client.received()).toContain('\r\n\r\nhelloHTTP/1.1 200');
      expect(client.received()).toContain('SECOND');
    }
  });

  it('takes the connection along for a body that is shorter than its length', async () => {
    for (const before of ['', get('/first')]) {
      const client = await serve(() => shape(new Response('hi', { headers: { 'content-length': '5' } })));
      client.socket.write(before + get('/file') + get('/second'));
      await client.closed;
      expect(client.received()).not.toContain('SECOND');
      if (before !== '') expect(client.received()).toContain('FIRST');
    }
  });

  it('counts the bytes of a body, not its characters', async () => {
    // Three characters, six bytes.
    const client = await serve(() => shape(new Response('äöü', { headers: { 'content-length': '6' } })));
    client.socket.write(get('/file') + get('/second'));
    await client.settled();
    expect(client.received()).toContain('SECOND');
    expect(client.socket.destroyed).toBe(false);
  });
});

describe('the bytes of a chunk written with an encoding', () => {
  // 'hi' is two characters and four bytes in UTF-16.
  it.each(['write', 'end'] as const)('are counted as bytes, not characters: %s() holds the length of 4', async (member) => {
    const client = await listen((request, response) =>
      guarded(async (_request, out) => {
        out.writeHead(200, { 'content-length': '4' });
        if (member === 'write') {
          out.write('hi', 'utf16le');
          out.end();
        } else out.end('hi', 'utf16le');
      })(request, response),
    );
    client.socket.write(get('/') + get('/'));
    while ((client.received().match(/HTTP\/1\.1 200/g) ?? []).length < 2) await new Promise((resolve) => client.socket.once('data', resolve));
    expect(client.received().split('\r\n\r\n')[1]!.startsWith('h\u0000i\u0000HTTP/1.1 200')).toBe(true);
  });
});

describe('direct writes of a listener', () => {
  const twice = async (answer: (out: ServerResponse) => void) => {
    const client = await listen((request, response) => guarded(async (_request, out) => answer(out))(request, response));
    client.socket.write(get('/') + get('/'));
    while ((client.received().match(/HTTP\/1\.1 200/g) ?? []).length < 2) await new Promise((resolve) => client.socket.once('data', resolve));
    return client.received();
  };

  it('keeps the chunk of a 200 that names no length: only a 500 without one is the adapter\'s error head', async () => {
    const received = await twice((out) => {
      out.writeHead(200);
      out.end('WHOLE');
    });
    expect(received).toContain('5\r\nWHOLE\r\n0\r\n\r\n');
  });

  it('holds a body to a length that was set on the response before its head', async () => {
    const received = await twice((out) => {
      out.setHeader('content-length', '4');
      out.writeHead(200);
      out.end('a'.repeat(24));
    });
    expect(received.split('\r\n\r\n')[1]!.startsWith('aaaaHTTP/1.1 200')).toBe(true);
  });

  it.each(['abc', '5, 9'])('holds a body to the length set before the head when the head names %j', async (named) => {
    const received = await twice((out) => {
      out.setHeader('content-length', '5');
      out.writeHead(200, { 'content-length': named });
      out.end('helloSURPLUS');
    });
    expect(received.split('\r\n\r\n')[1]!.startsWith('helloHTTP/1.1 200')).toBe(true);
  });

  it('holds a body to the length the adapter sets itself, with no headers', async () => {
    const received = await twice((out) => {
      // As the adapter does for a whole string body: the length is Node's field, no header names it.
      (out as unknown as { _contentLength: number })._contentLength = 5;
      out.writeHead(200);
      out.end('helloSURPLUS');
    });
    expect(received.split('\r\n\r\n')[1]!.startsWith('helloHTTP/1.1 200')).toBe(true);
  });

  it('cuts a chunk with an encoding at the length, in bytes of that encoding', async () => {
    // 'héllo' is five bytes in Latin-1 and six in UTF-8: the first three bytes are h, é, l.
    const received = await twice((out) => {
      out.writeHead(200, { 'content-length': '3' });
      out.end('héllo', 'latin1');
    });
    expect(received.split('\r\n\r\n')[1]!.startsWith('h\u00e9lHTTP/1.1 200')).toBe(true);
  });

  it.each([
    [['5', '5'], true],
    [['5', '9'], false],
  ] as const)('a Content-Length of the values %j: one length goes out, or none', async (value, goes) => {
    const received = await twice((out) => {
      out.writeHead(200, { 'content-length': [...value] as unknown as string });
      out.end('hello');
    });
    const head = received.split('\r\n\r\n')[0]!;
    if (goes) {
      expect(head.match(/content-length/gi)).toHaveLength(1);
      expect(head).toContain('content-length: 5');
    } else {
      expect(head).not.toMatch(/content-length/i);
      expect(head).toMatch(/transfer-encoding: chunked/i);
    }
  });
});

describe('a write after the body was cut', () => {
  it('is refused without an error, and nothing more goes out', async () => {
    const failures: unknown[] = [];
    let after: boolean | undefined;
    const client = await listen((request, response) =>
      guarded(async (_request, out) => {
        out.on('error', (error) => failures.push(error));
        out.writeHead(200, { 'content-length': '5' });
        out.write('helloSURPLUS');
        after = out.write('MORE');
        out.end('END');
      })(request, response),
    );
    client.socket.write(get('/') + get('/'));
    while ((client.received().match(/HTTP\/1\.1 200/g) ?? []).length < 2) await new Promise((resolve) => client.socket.once('data', resolve));
    expect(after).toBe(false);
    expect(failures).toEqual([]);
    expect(client.received()).not.toMatch(/MORE|END|SURPLUS/);
    expect(client.received().split('\r\n\r\n')[1]!.startsWith('helloHTTP/1.1 200')).toBe(true);
  });
});

describe('a listener that rejects', () => {
  it('is answered with a whole 500 before any head, the connection closes, and the promise resolves', async () => {
    const reported: unknown[] = [];
    const failure = new Error('REJECTED');
    let settled: Promise<void> | undefined;
    const client = await listen((request, response) => {
      settled = guarded(async () => {
        throw failure;
      }, (error) => reported.push(error))(request, response) as unknown as Promise<void>;
    });
    client.socket.write(get('/'));
    await client.closed;
    expect(client.received()).toMatch(/^HTTP\/1\.1 500 [^]*content-length: 0\r\n/i);
    expect(client.received()).not.toContain('REJECTED');
    await expect(settled).resolves.toBeUndefined();
    expect(reported).toEqual([failure]);
  });

  it('destroys the connection after a head, and still resolves', async () => {
    const reported: unknown[] = [];
    let settled: Promise<void> | undefined;
    const client = await listen((request, response) => {
      settled = guarded(async (_request, out) => {
        out.writeHead(200, { 'content-length': '10' });
        out.write('abc');
        throw new Error('AFTER-HEAD');
      }, (error) => reported.push(error))(request, response) as unknown as Promise<void>;
    });
    client.socket.write(get('/'));
    await client.closed;
    expect(client.received()).not.toContain('AFTER-HEAD');
    await expect(settled).resolves.toBeUndefined();
    expect(reported).toHaveLength(1);
  });

  it('resolves when the report itself throws', async () => {
    let settled: Promise<void> | undefined;
    const client = await listen((request, response) => {
      settled = guarded(async () => {
        throw new Error('REJECTED');
      }, () => {
        throw new Error('REPORT');
      })(request, response) as unknown as Promise<void>;
    });
    client.socket.write(get('/'));
    await client.closed;
    await expect(settled).resolves.toBeUndefined();
  });
});

describe('a status below 200', () => {
  it.each([101, 103])('is a whole 500 that closes the connection, %s', async (status) => {
    const reported: unknown[] = [];
    const client = await listen((request, response) =>
      guarded(async (_request, out) => {
        out.writeHead(status, { 'content-length': '0' });
        out.end();
      }, (error) => reported.push(error))(request, response),
    );
    client.socket.write(get('/') + get('/'));
    await client.closed;
    expect(client.received()).toMatch(/^HTTP\/1\.1 500 [^]*content-length: 0\r\n/i);
    expect(client.received().match(/HTTP\/1\.1/g)).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(RangeError);
  });
});

describe('the length a route names', () => {
  it.each(['5', '5, 5', '5,5'])('goes out once when every value is %j: cut at 5, the next response intact', async (value) => {
    for (const [, shape] of shapes) {
      const client = await serve(() => announcedAs('helloSURPLUS', value, shape));
      client.socket.write(get('/file') + get('/second'));
      await client.settled();
      const head = client.received().split('\r\n\r\n')[0]!;
      expect(head.match(/content-length/gi)).toHaveLength(1);
      expect(head).toContain('content-length: 5');
      expect(client.received()).toContain('\r\n\r\nhelloHTTP/1.1 200');
      expect(client.received()).toContain('SECOND');
    }
  });

  it.each(['5, 6', 'abc', '-1', '+5', '0x5', '1e1', '5.0'])('is not sent when it is %j: the body goes out whole and chunked, the next response intact', async (value) => {
    for (const [, shape] of shapes) {
      const client = await serve(() => announcedAs('hello', value, shape));
      client.socket.write(get('/file') + get('/second'));
      await client.settled();
      const head = client.received().split('\r\n\r\n')[0]!;
      expect(head).not.toMatch(/content-length/i);
      expect(head).toMatch(/transfer-encoding: chunked/i);
      expect(client.received()).toContain('hello');
      expect(client.received()).toContain('SECOND');
    }
  });

  it('is sent as the number it is when it has leading zeros', async () => {
    const client = await serve(() => announcedAs('helloSURPLUS', '05', (response) => response));
    client.socket.write(get('/file') + get('/second'));
    await client.settled();
    expect(client.received().split('\r\n\r\n')[0]).toContain('content-length: 5');
    expect(client.received()).toContain('\r\n\r\nhelloHTTP/1.1 200');
  });

  it.each(['identity', 'gzip'])('is not trusted next to Transfer-Encoding %s, with or without a length: Node frames the body', async (encoding) => {
    for (const extra of [{ 'transfer-encoding': encoding }, { 'transfer-encoding': encoding, 'content-length': '5' }]) {
      for (const [, shape] of shapes) {
        const client = await serve(() => shape(new Response(bodyOf('hello'), { headers: extra })));
        client.socket.write(get('/file') + get('/second'));
        await client.settled();
        const head = client.received().split('\r\n\r\n')[0]!;
        expect(head).not.toContain(encoding);
        expect(head).not.toMatch(/content-length/i);
        expect(head).toMatch(/transfer-encoding: chunked/i);
        expect(client.received()).toContain('SECOND');
      }
    }
  });

  it('with chunked and a length on HTTP/1.0: the body goes out whole and the connection closes after it', async () => {
    const client = await serve(() => new Response(bodyOf('hello'), { headers: { 'transfer-encoding': 'chunked', 'content-length': '5' } }));
    client.socket.write('GET /file HTTP/1.0\r\nhost: x\r\n\r\n');
    await client.closed;
    const head = client.received().split('\r\n\r\n')[0]!;
    expect(head).not.toMatch(/transfer-encoding/i);
    expect(client.received()).toMatch(/\r\n\r\nhello$/);
  });

  it('a Trailer header is not sent, so a body that fails while the socket drains never ends as a whole one', async () => {
    for (const [, shape] of shapes) {
      const client = await serve(() => shape(new Response(readsAhead(new Error('FAILURE-TEXT')), { headers: { trailer: 'x-sum' } })));
      client.socket.write(get('/file'));
      await client.closed;
      expect(client.received().split('\r\n\r\n')[0]).not.toMatch(/trailer/i);
      expect(client.received()).not.toMatch(/\r\n0\r\n\r\n$/);
      expect(client.received()).not.toContain('FAILURE-TEXT');
    }
  });
});

describe('a body of no byte with a length', () => {
  it('keeps its head, then the connection closes: nothing follows it', async () => {
    for (const [, shape] of shapes) {
      for (const before of ['', get('/first')]) {
        const client = await serve(() => shape(new Response(null, { headers: { 'content-length': '5', 'x-accel-redirect': '/protected' } })));
        client.socket.write(before + get('/file') + get('/second'));
        await client.closed;
        const received = client.received();
        const head = received.slice(received.lastIndexOf('HTTP/1.1 200'));
        expect(head).toMatch(/x-accel-redirect: \/protected/i);
        expect(head).toContain('content-length: 5');
        expect(received).not.toContain('SECOND');
      }
    }
  });
});

describe('what Node keeps on a response, which the guard reads', () => {
  it('ends the connection after a response whose _last is set', async () => {
    const lasts: unknown[] = [];
    const client = await listen((request, response) => {
      response.writeHead(200, { 'content-length': '0' });
      lasts.push((response as unknown as { _last: unknown })._last);
      response.end();
    });
    client.socket.write('GET /a HTTP/1.1\r\nhost: x\r\n\r\nGET /b HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n');
    await client.closed;
    expect(lasts).toEqual([false, true]);
    const keep = await listen((request, response) => {
      (response as unknown as { _last: boolean })._last = true;
      response.writeHead(200, { 'content-length': '0' });
      response.end();
    });
    keep.socket.write('GET /a HTTP/1.1\r\nhost: x\r\n\r\nGET /b HTTP/1.1\r\nhost: x\r\n\r\n');
    await keep.closed;
    expect(keep.received().match(/HTTP\/1\.1 200/g)).toHaveLength(1);
  });

  it('has _contentLength as a number with a length and null without, and _hasBody false for HEAD, 204 and 304', async () => {
    const seen: [string, unknown, unknown][] = [];
    const client = await listen((request, response) => {
      const inner = response as unknown as { _contentLength: unknown; _hasBody: unknown };
      const [method, path] = [request.method, request.url];
      if (path === '/with') response.writeHead(200, { 'content-length': '5' });
      else if (path === '/without') response.writeHead(200);
      else response.writeHead(path === '/204' ? 204 : path === '/304' ? 304 : 200);
      seen.push([`${method} ${path}`, inner._contentLength, inner._hasBody]);
      response.end(path === '/with' ? 'hello' : undefined);
    });
    client.socket.write('GET /with HTTP/1.1\r\nhost: x\r\n\r\nGET /without HTTP/1.1\r\nhost: x\r\n\r\nHEAD /head HTTP/1.1\r\nhost: x\r\n\r\nGET /204 HTTP/1.1\r\nhost: x\r\n\r\nGET /304 HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n');
    await client.closed;
    expect(seen).toEqual([
      ['GET /with', 5, true],
      ['GET /without', null, true],
      ['HEAD /head', null, false],
      ['GET /204', null, false],
      ['GET /304', null, false],
    ]);
  });
});

describe.each(shapes)('with the private fields of Node out of reach, for %s', (_name, shape) => {
  // The guard knows the length and the body from the head it let through. Node still needs `_hasBody` for itself, so that one only
  // says something other than it knows (always a body, as for HEAD); `_contentLength` is gone.
  const shadowed = (response: ServerResponse) => {
    Object.defineProperty(response, '_contentLength', { configurable: true, get: () => undefined, set: () => {} });
    Object.defineProperty(response, '_hasBody', { configurable: true, get: () => true, set: () => {} });
  };

  it('cuts 24 bytes to the 4 announced and answers the next response intact', async () => {
    const client = await serve(() => shape(new Response('a'.repeat(24), { headers: { 'content-length': '4' } })), shadowed);
    client.socket.write(get('/file') + get('/second'));
    await client.settled();
    expect(client.received()).toContain('\r\n\r\naaaaHTTP/1.1 200');
    expect(client.received()).toContain('SECOND');
  });

  it('takes the connection along for a body shorter than its length', async () => {
    const client = await serve(() => shape(new Response('aa', { headers: { 'content-length': '4' } })), shadowed);
    client.socket.write(get('/file') + get('/second'));
    await client.closed;
    expect(client.received()).not.toContain('SECOND');
  });

  it('keeps the connection of a HEAD that names a length', async () => {
    const client = await serve(() => shape(new Response(null, { headers: { 'content-length': '4' } })), shadowed);
    client.socket.write(get('/file').replace('GET', 'HEAD') + get('/second'));
    await client.settled();
    expect(client.received()).toContain('SECOND');
  });
});

it('closes the connection after a null body with a length also where Node has no _last', async () => {
  const client = await serve(() => new Response(null, { headers: { 'content-length': '5' } }), (response) => {
    Object.defineProperty(response, '_last', { configurable: true, get: () => undefined, set: () => {} });
  });
  client.socket.write(get('/file') + get('/second'));
  await client.closed;
  expect(client.received()).not.toContain('SECOND');
});
