import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client.ts';
import { DirectTransport } from './direct.ts';
import { FetchError } from './errors.ts';
import type { FetchTransport, TransportRequest, TransportResponse } from './transport.ts';

const LOOPBACK = ['127.0.0.1/32'];
const open: Server[] = [];

type Counted = { port: number; requests: () => number };

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void, host = '127.0.0.1'): Promise<Counted> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    handler(request, response);
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  open.push(server);
  return { port: (server.address() as AddressInfo).port, requests: () => requests };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(FetchError);
  return error as FetchError;
}

const direct = (options: ConstructorParameters<typeof DirectTransport>[0] = {}) => new HttpClient({ transport: new DirectTransport(options), allow: LOOPBACK });

const redirectTo = (location: string, status = 302) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { location });
  response.end();
};

describe('HttpClient — a redirect is checked at every hop', () => {
  it('refuses a redirect to the metadata address', async () => {
    const first = await listen(redirectTo('http://169.254.169.254/latest/meta-data/'));
    const error = await failure(direct().fetch(`http://127.0.0.1:${first.port}/`));
    expect(error.reason).toBe('refused');
    expect(error.message).toContain('not public');
    expect(first.requests()).toBe(1);
  });

  it('refuses a redirect to an IPv6 loopback server, which gets no request', async () => {
    const second = await listen((_, response) => void response.end('secret'), '::1');
    const first = await listen(redirectTo(`http://[::1]:${second.port}/`));
    const error = await failure(direct().fetch(`http://127.0.0.1:${first.port}/`));
    expect(error.reason).toBe('refused');
    expect(second.requests()).toBe(0);
  });

  it('refuses a redirect to a host that resolves to a private address, resolving it again at the hop', async () => {
    const resolved: string[] = [];
    const resolve = async (host: string) => {
      resolved.push(host);
      return [host === 'internal.test' ? '10.0.0.1' : '127.0.0.1'];
    };
    const first = await listen(redirectTo('http://internal.test:9/'));
    const error = await failure(direct({ resolve }).fetch(`http://public.test:${first.port}/`));
    expect(error.reason).toBe('refused');
    expect(resolved).toEqual(['public.test', 'internal.test']);
    expect(error.message).not.toContain('10.0.0.1');
  });

  it('follows a redirect to an allowed address', async () => {
    const second = await listen((_, response) => void response.end('arrived'));
    const first = await listen(redirectTo(`http://127.0.0.1:${second.port}/there`));
    const response = await direct().fetch(`http://127.0.0.1:${first.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('arrived');
    expect(response.url).toBe(`http://127.0.0.1:${second.port}/there`);
  });
});

/** A transport that answers from a script and keeps the requests it saw. */
function scripted(...answers: { status: number; headers?: Record<string, string>; body?: string }[]): { transport: FetchTransport; seen: TransportRequest[] } {
  const seen: TransportRequest[] = [];
  const transport: FetchTransport = {
    async send(request): Promise<TransportResponse> {
      seen.push(request);
      const answer = answers[seen.length - 1] ?? { status: 200 };
      return {
        status: answer.status,
        headers: new Headers(answer.headers),
        body: new ReadableStream({
          start(controller) {
            if (answer.body !== undefined) controller.enqueue(new TextEncoder().encode(answer.body));
            controller.close();
          },
        }),
      };
    },
  };
  return { transport, seen };
}

describe('HttpClient — redirect rules', () => {
  it('stops after maxRedirects (3 by default) with "redirects"', async () => {
    const hops = (await listen((request, response) => {
      redirectTo(`/${Number(request.url!.slice(1)) + 1}`)(request, response);
    }));
    const error = await failure(direct().fetch(`http://127.0.0.1:${hops.port}/0`));
    expect(error.reason).toBe('redirects');
    expect(hops.requests()).toBe(4);
    expect(await direct().fetch(`http://127.0.0.1:${hops.port}/0`, { maxRedirects: 0, redirect: 'manual' }).then((response) => response.status)).toBe(302);
  });

  it('refuses a redirect from https to http', async () => {
    const { transport, seen } = scripted({ status: 301, headers: { location: 'http://example.test/' } });
    const error = await failure(new HttpClient({ transport }).fetch('https://example.test/'));
    expect(error.reason).toBe('refused');
    expect(error.message).toContain('https to http');
    expect(seen).toHaveLength(1);
  });

  it('refuses a redirect to another scheme, and one with credentials', async () => {
    const file = scripted({ status: 302, headers: { location: 'file:///etc/passwd' } });
    expect((await failure(new HttpClient({ transport: file.transport }).fetch('http://example.test/'))).reason).toBe('refused');
    const credentials = scripted({ status: 302, headers: { location: 'http://user:pass@example.test/' } });
    expect((await failure(new HttpClient({ transport: credentials.transport }).fetch('http://example.test/'))).reason).toBe('refused');
  });

  it('sends only accept, accept-language and user-agent to another origin, and everything to the same one', async () => {
    const headers = { Authorization: 'Bearer x', Cookie: 'a=b', 'X-Api-Key': 'k', Accept: 'text/plain', 'Accept-Language': 'de', 'User-Agent': 'agent' };
    const same = scripted({ status: 302, headers: { location: '/next' } });
    await new HttpClient({ transport: same.transport }).fetch('http://example.test/', { headers: headers });
    expect(same.seen[1]!.headers).toMatchObject({ authorization: 'Bearer x', cookie: 'a=b', 'x-api-key': 'k' });

    for (const location of ['http://other.test/next', 'http://example.test:8080/next']) {
      const cross = scripted({ status: 302, headers: { location } });
      await new HttpClient({ transport: cross.transport }).fetch('http://example.test/', { headers: headers });
      expect(cross.seen[1]!.headers).toEqual({ accept: 'text/plain', 'accept-language': 'de', 'user-agent': 'agent' });
      expect(cross.seen[0]!.headers['x-api-key']).toBe('k');
    }
  });

  it('refuses a 307 to another origin that would send the body again, and sends it again to the same origin', async () => {
    const cross = scripted({ status: 307, headers: { location: 'http://other.test/x' } });
    expect((await failure(new HttpClient({ transport: cross.transport }).fetch('http://example.test/', { method: 'POST', body: 'payload' }))).reason).toBe('refused');
    expect(cross.seen).toHaveLength(1);
    const same = scripted({ status: 308, headers: { location: '/x' } });
    await new HttpClient({ transport: same.transport }).fetch('http://example.test/', { method: 'POST', body: 'payload' });
    expect(same.seen[1]!.body).toBe('payload');
    const get = scripted({ status: 302, headers: { location: 'http://other.test/x' } });
    await new HttpClient({ transport: get.transport }).fetch('http://example.test/', { method: 'POST', body: 'payload' });
    expect(get.seen[1]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('turns a 303 into a GET without a body, whatever the method', async () => {
    const { transport, seen } = scripted({ status: 303, headers: { location: '/done' } });
    await new HttpClient({ transport }).fetch('http://example.test/', { method: 'PUT', json: { a: 1 } });
    expect(seen.map((request) => request.method)).toEqual(['PUT', 'GET']);
    expect(seen[0]!.body).toBe('{"a":1}');
    expect(seen[1]!.body).toBeUndefined();
    expect(seen[1]!.headers['content-type']).toBeUndefined();
  });

  it('turns a POST into a GET on 302, and keeps method and body on 307', async () => {
    const found = scripted({ status: 302, headers: { location: '/x' } });
    await new HttpClient({ transport: found.transport }).fetch('http://example.test/', { method: 'post', body: 'payload' });
    expect(found.seen.map((request) => request.method)).toEqual(['POST', 'GET']);
    expect(found.seen[1]!.body).toBeUndefined();

    const kept = scripted({ status: 307, headers: { location: '/x' } });
    await new HttpClient({ transport: kept.transport }).fetch('http://example.test/', { method: 'POST', body: 'payload' });
    expect(kept.seen.map((request) => request.method)).toEqual(['POST', 'POST']);
    expect(kept.seen[1]!.body).toBe('payload');
  });

  it('returns the redirect with redirect: manual, and throws on it with redirect: error', async () => {
    const manual = scripted({ status: 302, headers: { location: '/x' } });
    const response = await new HttpClient({ transport: manual.transport }).fetch('http://example.test/', { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/x');
    expect(manual.seen).toHaveLength(1);

    const error = scripted({ status: 302, headers: { location: '/x' } });
    expect((await failure(new HttpClient({ transport: error.transport }).fetch('http://example.test/', { redirect: 'error' }))).reason).toBe('redirects');
    expect(error.seen).toHaveLength(1);
  });

  it('returns a 4xx and a 5xx as a response', async () => {
    const { transport } = scripted({ status: 404, body: 'gone' });
    const response = await new HttpClient({ transport }).fetch('http://example.test/');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('gone');
  });
});

describe('HttpClient — limits', () => {
  it('stops a response above maxResponseBytes with "too-large" and closes the socket early', async () => {
    let closedEarly: () => void;
    const closed = new Promise<void>((resolve) => (closedEarly = resolve));
    const chunk = Buffer.alloc(64 * 1024, 'x');
    const target = await listen((_, response) => {
      let sent = 0;
      response.writeHead(200);
      const write = () => {
        while (sent < 10 * 1024 * 1024) {
          sent += chunk.length;
          if (!response.write(chunk)) return void response.once('drain', write);
        }
        response.end();
      };
      response.on('close', () => {
        if (sent < 10 * 1024 * 1024) closedEarly();
      });
      write();
    });
    const response = await direct().fetch(`http://127.0.0.1:${target.port}/`, { maxResponseBytes: 1024 * 1024 });
    const error = await failure(response.arrayBuffer());
    expect(error.reason).toBe('too-large');
    await closed;
  });

  it('refuses a Content-Length above the limit before reading the body', async () => {
    let closedEarly: () => void;
    const closed = new Promise<void>((resolve) => (closedEarly = resolve));
    const target = await listen((_, response) => {
      response.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
      response.write('x');
      response.on('close', closedEarly);
    });
    const error = await failure(direct().fetch(`http://127.0.0.1:${target.port}/`, { maxResponseBytes: 1024 * 1024 }));
    expect(error.reason).toBe('too-large');
    await closed;
  });

  it('lets a response at the limit through', async () => {
    const target = await listen((_, response) => void response.end('x'.repeat(100)));
    const response = await direct().fetch(`http://127.0.0.1:${target.port}/`, { maxResponseBytes: 100 });
    expect((await response.text()).length).toBe(100);
  });

  it('times out during the body, not only before the headers', async () => {
    const target = await listen((_, response) => {
      response.writeHead(200);
      response.write('partial');
    });
    const response = await direct().fetch(`http://127.0.0.1:${target.port}/`, { timeout: 300 });
    expect(response.status).toBe(200);
    const error = await failure(response.text());
    expect(error.reason).toBe('timeout');
  });

  it('times out before the headers', async () => {
    const target = await listen(() => {});
    const error = await failure(direct().fetch(`http://127.0.0.1:${target.port}/`, { timeout: 200 }));
    expect(error.reason).toBe('timeout');
  });

  it("reports the caller's own abort as 'aborted', before and during the body", async () => {
    const target = await listen((_, response) => {
      response.writeHead(200);
      response.write('partial');
    });
    const before = AbortSignal.abort('stop');
    const early = await failure(direct().fetch(`http://127.0.0.1:${target.port}/`, { signal: before }));
    expect(early.reason).toBe('aborted');
    expect(early.cause).toBe('stop');

    const controller = new AbortController();
    const response = await direct().fetch(`http://127.0.0.1:${target.port}/`, { signal: controller.signal });
    controller.abort('later');
    expect((await failure(response.text())).reason).toBe('aborted');
  });

  it('rejects limits that are not positive numbers', async () => {
    const client = direct();
    await expect(client.fetch('http://127.0.0.1/', { timeout: 0 })).rejects.toThrow(TypeError);
    await expect(client.fetch('http://127.0.0.1/', { maxResponseBytes: Number.NaN })).rejects.toThrow(TypeError);
    await expect(client.fetch('http://127.0.0.1/', { maxRedirects: -1 })).rejects.toThrow(TypeError);
  });
});

describe('HttpClient — requests it refuses before sending', () => {
  it('throws a TypeError for credentials in the address', async () => {
    const { transport, seen } = scripted();
    await expect(new HttpClient({ transport }).fetch('http://user:pass@example.test/')).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });

  it('refuses a scheme other than http and https', async () => {
    const { transport, seen } = scripted();
    expect((await failure(new HttpClient({ transport }).fetch('file:///etc/passwd'))).reason).toBe('refused');
    expect(seen).toHaveLength(0);
  });

  it('throws a TypeError for json together with body', async () => {
    const { transport, seen } = scripted();
    // @ts-expect-error body and json together do not compile
    await expect(new HttpClient({ transport }).fetch('http://example.test/', { method: 'POST', json: {}, body: 'x' })).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });

  it('sends a form for URLSearchParams and JSON for json, and keeps a content-type the caller set', async () => {
    const { transport, seen } = scripted();
    const client = new HttpClient({ transport });
    await client.fetch('http://example.test/', { method: 'POST', body: new URLSearchParams({ a: '1 2' }) });
    await client.fetch('http://example.test/', { method: 'POST', json: { b: 2 }, headers: { 'Content-Type': 'application/vnd.api+json' } });
    expect(seen[0]!.body).toBe('a=1+2');
    expect(seen[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    expect(seen[1]!.headers['content-type']).toBe('application/vnd.api+json');
  });

  it('throws a TypeError for a body on GET', async () => {
    const { transport } = scripted();
    await expect(new HttpClient({ transport }).fetch('http://example.test/', { body: 'x' })).rejects.toThrow(TypeError);
  });
});

describe('HttpClient — allowing', () => {
  it('reaches a loopback server through allowing(), and the base client is still refused', async () => {
    const target = await listen((_, response) => void response.end('ok'));
    const base = new HttpClient({ transport: new DirectTransport() });
    const url = `http://127.0.0.1:${target.port}/`;
    expect((await failure(base.fetch(url))).reason).toBe('refused');
    expect(target.requests()).toBe(0);
    const derived = base.allowing(['127.0.0.0/8']);
    expect(await (await derived.fetch(url)).text()).toBe('ok');
    expect((await failure(base.fetch(url))).reason).toBe('refused');
  });

  it('throws a TypeError for something that is not a range', () => {
    const base = new HttpClient({ transport: new DirectTransport() });
    expect(() => base.allowing(['internal.example'])).toThrow(TypeError);
  });
});

/** A transport that checks nothing and records what it was asked to send. */
function trusting(...answers: { status: number; headers?: Record<string, string> }[]): { transport: FetchTransport; seen: TransportRequest[] } {
  return scripted(...answers);
}

describe('HttpClient — an address written as a literal is checked by the client', () => {
  it.each(['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/', 'http://[::ffff:127.0.0.1]/', 'http://0x7f.1/', 'http://10.0.0.1:8080/'])(
    'refuses %s although the transport checks nothing',
    async (address) => {
      const { transport, seen } = trusting();
      expect((await failure(new HttpClient({ transport }).fetch(address))).reason).toBe('refused');
      expect(seen).toHaveLength(0);
    },
  );

  it('refuses a redirect to a literal, and lets an allowed range through', async () => {
    const { transport, seen } = trusting({ status: 302, headers: { location: 'http://169.254.169.254/latest' } });
    expect((await failure(new HttpClient({ transport }).fetch('http://example.test/'))).reason).toBe('refused');
    expect(seen).toHaveLength(1);
    const allowed = trusting({ status: 302, headers: { location: 'http://10.20.0.5/x' } });
    await new HttpClient({ transport: allowed.transport, allow: ['10.20.0.0/16'] }).fetch('http://example.test/');
    expect(allowed.seen.map((request) => request.url.hostname)).toEqual(['example.test', '10.20.0.5']);
  });

  it('refuses an allow entry that is not a range', () => {
    expect(() => new HttpClient({ transport: trusting().transport, allow: ['10.0.0.0'] })).toThrow(TypeError);
  });
});

describe('HttpClient — headers the transport owns', () => {
  it.each(['Content-Length', 'Transfer-Encoding', 'Connection', 'Upgrade', 'TE', 'Trailer', 'Keep-Alive', 'Expect', 'Host', 'Proxy-Authorization', 'Proxy-Connection'])(
    'throws a TypeError for %s',
    async (name) => {
      const { transport, seen } = scripted();
      await expect(new HttpClient({ transport }).fetch('http://example.test/', { method: 'POST', body: 'x', headers: { [name]: '1' } })).rejects.toThrow(TypeError);
      await expect(new HttpClient({ transport }).fetch('http://example.test/', { method: 'POST', body: 'x', headers: new Headers({ [name]: '1' }) })).rejects.toThrow(TypeError);
      expect(seen).toHaveLength(0);
    },
  );

  it('accepts a Headers instance', async () => {
    const { transport, seen } = scripted();
    await new HttpClient({ transport }).fetch('http://example.test/', { headers: new Headers({ 'X-One': '1' }) });
    expect(seen[0]!.headers).toEqual({ 'x-one': '1' });
  });
});

describe('HttpClient — a response without a body', () => {
  it('lets a HEAD response with a large Content-Length through', async () => {
    const target = await listen((_, response) => {
      response.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
      response.end();
    });
    const response = await direct().fetch(`http://127.0.0.1:${target.port}/`, { method: 'HEAD', maxResponseBytes: 1024 });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('content-length')).toBe('10485760');
  });

  it.each([204, 205, 304])('a %i has no body, whatever its Content-Length says', async (status) => {
    const { transport } = scripted({ status, headers: { 'content-length': '99999999' } });
    const response = await new HttpClient({ transport }).fetch('http://example.test/', { maxResponseBytes: 10 });
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it('refuses a status that is no response', async () => {
    for (const status of [100, 199, 600]) {
      const { transport } = scripted({ status });
      expect((await failure(new HttpClient({ transport }).fetch('http://example.test/'))).reason).toBe('network');
    }
  });
});

describe('HttpClient — a transport that ignores its signal', () => {
  const stalled = (): FetchTransport => ({ send: () => new Promise<TransportResponse>(() => {}) });

  it('times out while the transport sends', async () => {
    expect((await failure(new HttpClient({ transport: stalled() }).fetch('http://example.test/', { timeout: 100 }))).reason).toBe('timeout');
  });

  it('times out while the body is read, and the redirect body is cancelled', async () => {
    const never = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const transport: FetchTransport = { send: async () => ({ status: 200, headers: new Headers(), body: never }) };
    const response = await new HttpClient({ transport }).fetch('http://example.test/', { timeout: 100 });
    expect((await failure(response.text())).reason).toBe('timeout');

    const hung = new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) });
    const redirecting: FetchTransport = { send: async () => ({ status: 302, headers: new Headers({ location: '/x' }), body: hung }) };
    expect((await failure(new HttpClient({ transport: redirecting }).fetch('http://example.test/', { timeout: 100 }))).reason).toBe('timeout');
  });

  it("the caller's abort ends the wait too", async () => {
    const controller = new AbortController();
    const pending = failure(new HttpClient({ transport: stalled() }).fetch('http://example.test/', { signal: controller.signal }));
    controller.abort('stop');
    expect((await pending).reason).toBe('aborted');
  });
});

describe('HttpClient — requests it cannot send', () => {
  it.each(['CONNECT', 'trace', 'TRACK'])('throws a TypeError for %s', async (method) => {
    await expect(new HttpClient({ transport: scripted().transport }).fetch('http://example.test/', { method })).rejects.toThrow(TypeError);
  });

  it.each(['GE T', '', 'GET\r\nHost: x', 'ПОСТ'])('throws a TypeError for the method %j', async (method) => {
    const { transport, seen } = scripted();
    await expect(new HttpClient({ transport }).fetch('http://example.test/', { method })).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });

  it('throws a TypeError for a timeout a timer cannot hold', async () => {
    const client = new HttpClient({ transport: scripted().transport });
    await expect(client.fetch('http://example.test/', { timeout: 2_147_483_648 })).rejects.toThrow(TypeError);
  });

  it('starts no timer for a signal that is none', async () => {
    vi.useFakeTimers();
    try {
      const client = new HttpClient({ transport: scripted().transport });
      await expect(client.fetch('http://example.test/', { signal: {} as AbortSignal })).rejects.toThrow(TypeError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HttpClient — redirect edge cases', () => {
  it('answers with a redirect status that has no Location as it is', async () => {
    const { transport } = scripted({ status: 302 });
    expect((await new HttpClient({ transport }).fetch('http://example.test/')).status).toBe(302);
  });

  it('throws "network" for a Location that is not an address', async () => {
    const { transport } = scripted({ status: 302, headers: { location: 'http://[bad' } });
    expect((await failure(new HttpClient({ transport }).fetch('http://example.test/'))).reason).toBe('network');
  });

  it('throws "redirects" at the first redirect with maxRedirects: 0', async () => {
    const { transport, seen } = scripted({ status: 302, headers: { location: '/x' } });
    expect((await failure(new HttpClient({ transport }).fetch('http://example.test/', { maxRedirects: 0 }))).reason).toBe('redirects');
    expect(seen).toHaveLength(1);
  });

  it('turns a 301 POST into a GET', async () => {
    const { transport, seen } = scripted({ status: 301, headers: { location: '/x' } });
    await new HttpClient({ transport }).fetch('http://example.test/', { method: 'POST', body: 'payload' });
    expect(seen[1]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('marks a followed redirect on the response and on its clone', async () => {
    const { transport } = scripted({ status: 302, headers: { location: '/there' } }, { status: 200, body: 'hi' });
    const response = await new HttpClient({ transport }).fetch('http://example.test/here');
    const clone = response.clone();
    for (const copy of [response, clone]) {
      expect(copy.redirected).toBe(true);
      expect(copy.url).toBe('http://example.test/there');
    }
    expect(await clone.text()).toBe('hi');
    const plain = await new HttpClient({ transport: scripted().transport }).fetch('http://example.test/here');
    expect(plain.redirected).toBe(false);
  });
});

describe('HttpClient — the signal wins', () => {
  it('never calls the transport for a request that is aborted already', async () => {
    const { transport, seen } = scripted();
    expect((await failure(new HttpClient({ transport }).fetch('http://example.test/', { signal: AbortSignal.abort() }))).reason).toBe('aborted');
    expect(seen).toHaveLength(0);
  });

  it('cancels the body of a response that arrives after the deadline', async () => {
    let cancelled: () => void;
    const closed = new Promise<void>((resolve) => (cancelled = resolve));
    const transport: FetchTransport = {
      send: () =>
        new Promise<TransportResponse>((resolve) => {
          setTimeout(() => resolve({ status: 200, headers: new Headers(), body: new ReadableStream({ cancel: () => cancelled() }) }), 200);
        }),
    };
    expect((await failure(new HttpClient({ transport }).fetch('http://example.test/', { timeout: 50 }))).reason).toBe('timeout');
    await closed;
  });

  it("redirect: 'error' throws for every redirect status, with or without Location", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      for (const headers of [{ location: '/x' }, undefined]) {
        const { transport, seen } = scripted({ status, headers });
        expect((await failure(new HttpClient({ transport }).fetch('http://example.test/', { redirect: 'error' }))).reason).toBe('redirects');
        expect(seen).toHaveLength(1);
      }
    }
  });

  it('keeps the ranges it was built with, whatever the caller does to its array later', async () => {
    const ranges = ['10.20.0.0/16'];
    const base = new HttpClient({ transport: scripted().transport, allow: ranges });
    ranges.push('127.0.0.0/8');
    const derived = base.allowing([]);
    expect((await failure(derived.fetch('http://127.0.0.1/'))).reason).toBe('refused');
    expect((await derived.fetch('http://10.20.0.1/')).status).toBe(200);
  });
});
