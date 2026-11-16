import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { rootCertificates } from 'node:tls';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { parseRange } from './addresses.ts';
import { send, trustedAuthorities } from './direct.ts';
import { FetchError } from './errors.ts';

const run = promisify(execFile);

type Counted = { server: Server; port: number; connections: () => number; requests: () => number };

/** What a test opens: closed after it, connections first. */
const open: { closeAllConnections(): void; close(callback: () => void): unknown }[] = [];

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void = (_, response) => void response.end('ok')): Promise<Counted> {
  let connections = 0;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    handler(request, response);
  });
  server.on('connection', () => void connections++);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(server);
  return { server, port: (server.address() as AddressInfo).port, connections: () => connections, requests: () => requests };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

const LOOPBACK = [parseRange('127.0.0.1/32')];

async function refusal(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(FetchError);
  return error as FetchError;
}

describe('direct — refuses before any socket opens', () => {
  it.each([
    ['an IPv4 literal', (port: number) => `http://127.0.0.1:${port}/`],
    ['a mapped IPv6 literal', (port: number) => `http://[::ffff:127.0.0.1]:${port}/`],
    ['a disguised IPv4 literal', (port: number) => `http://0x7f.1:${port}/`],
    ['localhost', (port: number) => `http://localhost:${port}/`],
  ])('%s', async (_name, url) => {
    const target = await listen();
    const error = await refusal(send({ url: new URL(url(target.port)) }, { allow: [] }));
    expect(error.reason).toBe('refused');
    expect(error.message).toContain('resolves to an address that is not public');
    expect(target.connections()).toBe(0);
    expect(target.requests()).toBe(0);
  });

  it('a host whose resolver answers a public and a private address', async () => {
    const target = await listen();
    let asked = 0;
    const error = await refusal(
      send({ url: new URL(`http://mixed.example:${target.port}/`) }, { allow: [], resolve: async () => (asked++, ['93.184.216.34', '127.0.0.1']) }),
    );
    expect(error.reason).toBe('refused');
    expect(asked).toBe(1);
    expect(target.connections()).toBe(0);
  });

  it('keeps the resolved address out of the message and in the cause', async () => {
    const error = await refusal(send({ url: new URL('http://rebind.example/') }, { allow: [], resolve: async () => ['10.1.2.3'] }));
    expect(error.message).toBe('The host "rebind.example" resolves to an address that is not public.');
    expect(error.cause).toEqual({ addresses: ['10.1.2.3'] });
  });

  it('an answer that is not an address', async () => {
    const error = await refusal(send({ url: new URL('http://odd.example/') }, { allow: [], resolve: async () => ['not-an-address'] }));
    expect(error.reason).toBe('refused');
  });
});

describe('direct — pins the connection to the checked list', () => {
  it('reaches the server through a name the operating system cannot resolve', async () => {
    const target = await listen((_, response) => void response.end('pinned'));
    const response = await send({ url: new URL(`http://pinned.invalid:${target.port}/path?q=1`) }, { allow: LOOPBACK, resolve: async () => ['127.0.0.1'] });
    expect(response.status).toBe(200);
    expect(await new Response(response.body).text()).toBe('pinned');
    expect(target.connections()).toBe(1);
  });

  it('asks the resolver once per request, also when its second answer would be private', async () => {
    const target = await listen();
    const answers = [['127.0.0.1'], ['10.0.0.1']];
    let asked = 0;
    const resolve = async () => answers[Math.min(asked++, 1)]!;
    const response = await send({ url: new URL(`http://rebind.example:${target.port}/`) }, { allow: LOOPBACK, resolve });
    await response.body.cancel();
    expect(asked).toBe(1);
    expect(target.connections()).toBe(1);
  });

  it('keeps the Host header on the name and sends no compression', async () => {
    let seen: IncomingMessage['headers'] = {};
    const target = await listen((request, response) => {
      seen = request.headers;
      response.end('x');
    });
    const response = await send(
      { url: new URL(`http://named.invalid:${target.port}/`), headers: { 'Accept-Encoding': 'gzip', Host: 'other.example' } },
      { allow: LOOPBACK, resolve: async () => ['127.0.0.1'] },
    );
    await response.body.cancel();
    expect(seen.host).toBe(`named.invalid:${target.port}`);
    expect(seen['accept-encoding']).toBe('identity');
  });

  it('sends the method, a body and returns the headers, and follows no redirect', async () => {
    let received = '';
    const target = await listen((request, response) => {
      request.setEncoding('utf8').on('data', (chunk: string) => (received += chunk));
      request.on('end', () => {
        response.writeHead(302, { location: 'http://10.0.0.1/', 'x-method': request.method ?? '' });
        response.end();
      });
    });
    const response = await send(
      { url: new URL(`http://127.0.0.1:${target.port}/`), method: 'POST', body: 'payload' },
      { allow: LOOPBACK },
    );
    await response.body.cancel();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://10.0.0.1/');
    expect(response.headers.get('x-method')).toBe('POST');
    expect(received).toBe('payload');
    expect(target.requests()).toBe(1);
  });
});

describe('direct — time limits and abort', () => {
  it('gives a timeout when the server accepts and never answers', async () => {
    const target = await listen(() => {});
    const error = await refusal(send({ url: new URL(`http://127.0.0.1:${target.port}/`) }, { allow: LOOPBACK, timeouts: { response: 50 } }));
    expect(error.reason).toBe('timeout');
    expect(target.connections()).toBe(1);
  });

  it('gives a timeout when name resolution does not finish', async () => {
    const error = await refusal(send({ url: new URL('http://slow.example/') }, { allow: [], timeouts: { connect: 50 }, resolve: () => new Promise(() => {}) }));
    expect(error.reason).toBe('timeout');
  });

  it('aborts with the caller signal, before and during the request', async () => {
    const target = await listen(() => {});
    const early = AbortSignal.abort('stop');
    const error = await refusal(send({ url: new URL(`http://127.0.0.1:${target.port}/`), signal: early }, { allow: LOOPBACK }));
    expect(error.reason).toBe('aborted');
    expect(error.cause).toBe('stop');
    expect(target.connections()).toBe(0);
    const controller = new AbortController();
    const pending = refusal(send({ url: new URL(`http://127.0.0.1:${target.port}/`), signal: controller.signal }, { allow: LOOPBACK }));
    await new Promise<void>((resolve) => target.server.once('request', () => resolve()));
    controller.abort();
    expect((await pending).reason).toBe('aborted');
  });

  it('asks the resolver nothing when the signal is aborted already', async () => {
    let asked = 0;
    const error = await refusal(
      send({ url: new URL('http://named.example/'), signal: AbortSignal.abort() }, { allow: [], resolve: async () => (asked++, ['93.184.216.34']) }),
    );
    expect(error.reason).toBe('aborted');
    expect(asked).toBe(0);
  });

  it('aborts while the body is being read, with a FetchError', async () => {
    const target = await listen((_, response) => {
      response.writeHead(200);
      response.write('first');
    });
    const controller = new AbortController();
    const response = await send({ url: new URL(`http://127.0.0.1:${target.port}/`), signal: controller.signal }, { allow: LOOPBACK });
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    controller.abort();
    const error = await reader.read().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).reason).toBe('aborted');
  });

  it('turns a connection reset in the body into a network FetchError', async () => {
    const target = await listen((_, response) => {
      response.writeHead(200, { 'content-length': '100' });
      response.write('partial');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    const response = await send({ url: new URL(`http://127.0.0.1:${target.port}/`) }, { allow: LOOPBACK });
    const error = await new Response(response.body).text().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).reason).toBe('network');
  });

  it('reports a refused connection as a network failure', async () => {
    const target = await listen();
    const port = target.port;
    await new Promise<void>((resolve) => target.server.close(() => resolve()));
    const error = await refusal(send({ url: new URL(`http://127.0.0.1:${port}/`) }, { allow: LOOPBACK }));
    expect(error.reason).toBe('network');
  });
});

describe('direct — answers that are not a response', () => {
  /** A raw TCP server that answers the first bytes of every connection with `reply` and keeps the socket open. */
  async function raw(reply: string): Promise<{ port: number; connections: () => number }> {
    let connections = 0;
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('data', () => {
        if (reply !== '') socket.write(reply);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    open.push({ closeAllConnections: () => sockets.forEach((socket) => socket.destroy()), close: (callback) => server.close(callback) });
    return { port: (server.address() as AddressInfo).port, connections: () => connections };
  }

  const upgrade = 'HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: x\r\n\r\n';
  const connect = 'HTTP/1.1 200 Connection established\r\n\r\n';
  const answers = [
    ['101 Switching Protocols', upgrade, undefined],
    ['200 to CONNECT', connect, 'CONNECT'],
  ] as const;

  it.each(answers)('settles with a FetchError for %s', async (_name, reply, method) => {
    const target = await raw(reply);
    const error = await refusal(send({ url: new URL(`http://127.0.0.1:${target.port}/`), method }, { allow: LOOPBACK, timeouts: { response: 5_000 } }));
    expect(error.reason).toBe('network');
    expect(target.connections()).toBe(1);
  });

  it.each(answers)('times out against a silent server, method of %s', async (_name, _reply, method) => {
    const silent = await raw('');
    const timedOut = await refusal(send({ url: new URL(`http://127.0.0.1:${silent.port}/`), method }, { allow: LOOPBACK, timeouts: { response: 50 } }));
    expect(timedOut.reason).toBe('timeout');
  });

  it.each(answers)('aborts after the server has sent %s', async (_name, reply, method) => {
    const answered = Promise.withResolvers<void>();
    const server = createNetServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.write(reply, () => answered.resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    open.push({ closeAllConnections: () => {}, close: (callback) => server.close(callback) });
    const controller = new AbortController();
    const pending = refusal(send({ url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`), method, signal: controller.signal }, { allow: LOOPBACK, timeouts: { response: 5_000 } }));
    await answered.promise;
    controller.abort();
    // The request closes on the answer, so it may have settled already; either way it settled with a FetchError, never hung.
    expect(['aborted', 'network']).toContain((await pending).reason);
  });
});

describe('direct — a request that cannot be sent', () => {
  it.each([
    ['a header value with a line break', { headers: { 'x-a': 'one\r\nx-injected: yes' } }],
    ['a header name that is not a token', { headers: { 'x a': 'one' } }],
    ['a method that is not a token', { method: 'GE T' }],
  ])('refuses %s without opening a socket', async (_name, extra) => {
    const target = await listen();
    const error = await refusal(send({ url: new URL(`http://127.0.0.1:${target.port}/`), ...extra }, { allow: LOOPBACK }));
    expect(error.reason).toBe('refused');
    expect(target.connections()).toBe(0);
  });

  it('sends a header named __proto__ instead of dropping it', async () => {
    let raw: string[] = [];
    const target = await listen((request, response) => {
      raw = request.rawHeaders;
      response.end('ok');
    });
    const headers = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
    const response = await send({ url: new URL(`http://127.0.0.1:${target.port}/`), headers }, { allow: LOOPBACK });
    await response.body.cancel();
    expect(raw.map((entry) => entry.toLowerCase())).toContain('__proto__');
  });

  it('refuses a scheme other than http and https', async () => {
    expect((await refusal(send({ url: new URL('ftp://127.0.0.1/') }, { allow: LOOPBACK }))).reason).toBe('refused');
    expect((await refusal(send({ url: new URL('file:///etc/hosts') }, { allow: LOOPBACK }))).reason).toBe('refused');
  });

  it('refuses a user name or a password in the address instead of dropping it', async () => {
    const target = await listen();
    for (const authority of ['user@', 'user:secret@', ':secret@']) {
      const error = await refusal(send({ url: new URL(`http://${authority}127.0.0.1:${target.port}/`) }, { allow: LOOPBACK }));
      expect(error.reason).toBe('refused');
      expect(error.message).toBe('The address carries a user name or a password. Send credentials in a header instead.');
    }
    expect(target.connections()).toBe(0);
  });
});

describe('direct — IPv6 and https', () => {
  it('connects to an allowed IPv6 literal and refuses it without the range', async () => {
    const server = createServer((_, response) => void response.end('six'));
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '::1', resolve));
    open.push(server);
    const port = (server.address() as AddressInfo).port;
    const response = await send({ url: new URL(`http://[::1]:${port}/`) }, { allow: [parseRange('::1/128')] });
    expect(await new Response(response.body).text()).toBe('six');
    expect((await refusal(send({ url: new URL(`http://[::1]:${port}/`) }, { allow: LOOPBACK }))).reason).toBe('refused');
  });

  it('pins the connection of an https request and keeps the name for SNI and the certificate', async () => {
    const dir = tempDir('marmeon-fetch-tls-');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-subj', '/CN=pinned.invalid', '-addext', 'subjectAltName=DNS:pinned.invalid', '-days', '1'], { stdio: 'pipe' });
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    let serverName: string | false | null | undefined;
    let secured = 0;
    const server = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (_, response) => void response.end('secure'));
    server.on('secureConnection', (socket) => {
      secured++;
      serverName = socket.servername;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    open.push(server);
    const port = (server.address() as AddressInfo).port;

    const response = await send({ url: new URL(`https://pinned.invalid:${port}/`) }, { allow: LOOPBACK, ca: cert, resolve: async () => ['127.0.0.1'] });
    expect(await new Response(response.body).text()).toBe('secure');
    expect(serverName).toBe('pinned.invalid');
    expect(secured).toBe(1);

    const other = await refusal(send({ url: new URL(`https://127.0.0.1:${port}/`) }, { allow: LOOPBACK, ca: cert }));
    expect(other.reason).toBe('network');
  });
});

describe('direct — the https handshake', () => {
  it('counts a peer that accepts TCP and never speaks TLS against the connect deadline', async () => {
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    open.push({ closeAllConnections: () => sockets.forEach((socket) => socket.destroy()), close: (callback) => server.close(callback) });
    const error = await refusal(
      send({ url: new URL(`https://127.0.0.1:${(server.address() as AddressInfo).port}/`) }, { allow: LOOPBACK, timeouts: { connect: 100, response: 20_000 } }),
    );
    expect(error.reason).toBe('timeout');
    expect(error.message).toBe('The connection was not established in time.');
  });
});

describe('direct — trusted authorities', () => {
  it('keeps the built-in authorities next to an extra one, and leaves Node’s list alone without one', () => {
    const list = trustedAuthorities('extra-certificate');
    expect(list).toContain('extra-certificate');
    expect(list).toEqual(expect.arrayContaining(rootCertificates.slice(0, 5)));
    expect(list!.length).toBeGreaterThan(50);
    expect(trustedAuthorities(undefined)).toBeUndefined();
  });
});

describe('direct — no environment proxy', () => {
  it('goes straight to the server with HTTP_PROXY and NODE_USE_ENV_PROXY set', async () => {
    const target = await listen();
    const proxy = await listen();
    const probe = new URL('./__fixtures__/probe.ts', import.meta.url).pathname;
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const { stdout } = await run(process.execPath, [probe, `http://127.0.0.1:${target.port}/`], {
      timeout: 20_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' },
    });
    expect(stdout.trim()).toBe('200');
    expect(target.connections()).toBe(1);
    expect(proxy.connections()).toBe(0);
  });
});
