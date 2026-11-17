import { AssertionError } from 'node:assert';
import { describe, expect, it, vi } from 'vitest';
import { FetchError } from './errors.ts';
import { HttpClientFake } from './fake.ts';

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(FetchError);
  return error as FetchError;
}

describe('HttpClientFake — answering', () => {
  it('answers a request from the reply that matches, for a string, a pattern and a function', async () => {
    const http = new HttpClientFake()
      .respond('https://a.example.com/exact', new Response('exact'))
      .respond(/^https:\/\/b\.example\.com\//g, new Response('pattern'))
      .respond((request) => request.method === 'POST', new Response('post', { status: 201 }));
    expect(await (await http.fetch('https://a.example.com/exact')).text()).toBe('exact');
    // A pattern with the g flag keeps no state between requests.
    expect(await (await http.fetch('https://b.example.com/one')).text()).toBe('pattern');
    expect(await (await http.fetch('https://b.example.com/two')).text()).toBe('pattern');
    const posted = await http.fetch('https://c.example.com/', { method: 'POST', json: { a: 1 } });
    expect([posted.status, await posted.text()]).toEqual([201, 'post']);
  });

  it('copies a static reply for every request and lets the latest matching registration win', async () => {
    const http = new HttpClientFake().respond(/example/, new Response('first')).respond(/example/, new Response('second'));
    expect(await (await http.fetch('https://x.example.com/')).text()).toBe('second');
    expect(await (await http.fetch('https://x.example.com/')).text()).toBe('second');
  });

  it('calls a reply function with the request, body included, and awaits its promise', async () => {
    const http = new HttpClientFake().respond(/hook/, async (request) => new Response(`got ${await request.text()}`));
    const response = await http.fetch('https://hooks.example.com/hook', { method: 'POST', body: 'hello' });
    expect(await response.text()).toBe('got hello');
    expect(await http.requests[0]!.clone().text()).toBe('hello');
  });

  it('throws a network FetchError for a request nobody answered, and says what to add', async () => {
    const http = new HttpClientFake().respond('https://a.example.com/', new Response('x'));
    const error = await failure(http.fetch('https://other.example.com/path', { method: 'PUT', body: 'x' }));
    expect(error.reason).toBe('network');
    expect(error.message).toBe('no fake response for PUT https://other.example.com/path — add app.http.respond(…)');
  });

  it('follows a redirect through the client, matching every hop', async () => {
    const http = new HttpClientFake()
      .respond('https://a.example.com/', new Response(null, { status: 302, headers: { location: 'https://b.example.com/done' } }))
      .respond('https://b.example.com/done', new Response('arrived'));
    const response = await http.fetch('https://a.example.com/');
    expect([await response.text(), response.redirected, response.url]).toEqual(['arrived', true, 'https://b.example.com/done']);
    http.assertSentCount(2);
  });
});

describe('HttpClientFake — static replies', () => {
  it('follows a redirect whose static reply has a body, and answers every request with a fresh response', async () => {
    const http = new HttpClientFake()
      .respond('https://a.example.com/', new Response('redirecting', { status: 302, headers: { location: '/done' } }))
      .respond('https://a.example.com/done', new Response('arrived', { headers: { 'x-a': 'b' } }));
    for (let round = 0; round < 2; round++) {
      const response = await http.fetch('https://a.example.com/');
      expect([await response.text(), response.redirected, response.headers.get('x-a')]).toEqual(['arrived', true, 'b']);
    }
    const direct = await http.fetch('https://a.example.com/done', { redirect: 'manual' });
    expect(await direct.text()).toBe('arrived');
    expect([(await http.fetch('https://a.example.com/', { redirect: 'manual' })).status, (await http.respond('https://b.example.com/', new Response(null, { status: 204 })).fetch('https://b.example.com/')).status]).toEqual([302, 204]);
  });
});

describe('HttpClientFake — one response for several registrations, and streams', () => {
  it('leaves the response a test registered unread, so it can answer two addresses', async () => {
    const shared = new Response('same');
    const http = new HttpClientFake().respond('https://a.example.com/', shared).respond('https://b.example.com/', shared);
    expect(await (await http.fetch('https://a.example.com/')).text()).toBe('same');
    expect(await (await http.fetch('https://b.example.com/')).text()).toBe('same');
    expect(shared.bodyUsed).toBe(false);
  });

  it('follows a redirect from a function reply whose body never ends', async () => {
    const endless = () => new Response(new ReadableStream({ pull: (controller) => void controller.enqueue(new Uint8Array([1])) }), { status: 302, headers: { location: '/done' } });
    const http = new HttpClientFake().respond('https://a.example.com/', endless).respond('https://a.example.com/done', new Response('arrived'));
    expect(await (await http.fetch('https://a.example.com/')).text()).toBe('arrived');
  });
});

describe('HttpClientFake — the address policy', () => {
  const PRIVATE = ['http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://10.1.2.3/', 'http://app.localhost/'];

  it.each(PRIVATE)('refuses %s with no reply called and nothing recorded', async (url) => {
    const reply = vi.fn(() => new Response('secret'));
    const http = new HttpClientFake().respond(/.*/, reply);
    const error = await failure(http.fetch(url));
    expect(error.reason).toBe('refused');
    expect(reply).not.toHaveBeenCalled();
    http.assertNothingSent();
  });

  it('refuses a host that dns() maps to a private address, and one of several that is private', async () => {
    const reply = vi.fn(() => new Response('secret'));
    const http = new HttpClientFake().respond(/.*/, reply).dns('internal.example.com', ['10.0.0.5']).dns('mixed.example.com', ['93.184.216.34', '192.168.1.1']);
    expect((await failure(http.fetch('https://internal.example.com/'))).reason).toBe('refused');
    expect((await failure(http.fetch('https://mixed.example.com/'))).reason).toBe('refused');
    expect(reply).not.toHaveBeenCalled();
  });

  it('answers a host that dns() maps to a public address, and a host nobody mapped', async () => {
    const http = new HttpClientFake().respond(/.*/, () => new Response('ok')).dns('public.example.com', ['93.184.216.34']);
    expect((await http.fetch('https://public.example.com/')).status).toBe(200);
    expect((await http.fetch('https://unmapped.example.com/')).status).toBe(200);
  });

  it('fails a host that dns() maps to nothing as a network error', async () => {
    const http = new HttpClientFake().respond(/.*/, new Response('x')).dns('gone.example.com', []);
    expect((await failure(http.fetch('https://gone.example.com/'))).reason).toBe('network');
  });

  it('judges a redirect target at its hop: a public http host that redirects to the metadata address is refused', async () => {
    const reply = vi.fn(() => new Response('secret'));
    const http = new HttpClientFake()
      .respond('http://a.example.com/', new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
      .respond('http://169.254.169.254/', reply);
    const error = await failure(http.fetch('http://a.example.com/'));
    expect([error.reason, error.message]).toEqual(['refused', 'The host is an address that is not public.']);
    expect(reply).not.toHaveBeenCalled();
    http.assertSentCount(1);
  });

  it('judges a host that dns() maps at a redirect hop', async () => {
    const reply = vi.fn(() => new Response('secret'));
    const http = new HttpClientFake()
      .dns('inner.example.com', ['10.0.0.9'])
      .respond('https://a.example.com/', new Response(null, { status: 302, headers: { location: 'https://inner.example.com/' } }))
      .respond(/inner/, reply);
    expect((await failure(http.fetch('https://a.example.com/'))).reason).toBe('refused');
    expect(reply).not.toHaveBeenCalled();
  });

  it('lets the ranges it was made with, and allowing(), through', async () => {
    const reply = () => new Response('ok');
    const open = new HttpClientFake(['10.20.0.0/16']).respond(/.*/, reply);
    expect((await open.fetch('http://10.20.1.1/')).status).toBe(200);
    expect((await failure(open.fetch('http://10.30.1.1/'))).reason).toBe('refused');
    const closed = new HttpClientFake().respond(/.*/, reply);
    expect((await closed.allowing(['10.30.0.0/16']).fetch('http://10.30.1.1/')).status).toBe(200);
    closed.assertSentCount(1);
    expect((await failure(closed.fetch('http://10.30.1.1/'))).reason).toBe('refused');
  });
});

describe('HttpClientFake — what a test writes is checked', () => {
  it('refuses a punycode host that dns() maps through its Unicode name, with no reply called', async () => {
    const reply = vi.fn(() => new Response('secret'));
    const http = new HttpClientFake().respond(/.*/, reply).dns('bücher.example', ['10.0.0.5']).dns('EXAMPLE-IDN.test.', ['192.168.0.1']);
    expect((await failure(http.fetch('https://xn--bcher-kva.example/'))).reason).toBe('refused');
    expect((await failure(http.fetch('https://bücher.example/'))).reason).toBe('refused');
    expect((await failure(http.fetch('https://example-idn.test/'))).reason).toBe('refused');
    expect(reply).not.toHaveBeenCalled();
  });

  it('throws a TypeError for a dns() key that is no host', () => {
    expect(() => new HttpClientFake().dns('a.example/path', [])).toThrow(TypeError);
    expect(() => new HttpClientFake().dns('user@a.example', [])).toThrow(TypeError);
    expect(() => new HttpClientFake().dns('', [])).toThrow(TypeError);
    for (const key of ['a.example:8443', 'a.example:80', 'https://a.example', 'a.example?x', 'a.example#x', '[::1', '::1']) expect(() => new HttpClientFake().dns(key, []), key).toThrow(TypeError);
  });

  it('keeps a bracketed IPv6 address as a dns() key', async () => {
    const http = new HttpClientFake().respond(/.*/, new Response('x')).dns('[2001:db8::1]', ['10.0.0.1']);
    expect((await failure(http.fetch('http://[2001:db8::1]/'))).reason).toBe('refused');
  });

  it('matches and asserts a string address as fetch writes it, and throws a TypeError for a text that is no address', async () => {
    const http = new HttpClientFake().respond('HTTPS://Hooks.Example.com:443/in', new Response('ok'));
    expect((await http.fetch('https://hooks.example.com/in')).status).toBe(200);
    http.assertSent('https://HOOKS.example.com/in');
    expect(() => http.respond('not an address', new Response())).toThrow(TypeError);
    expect(() => http.assertSent('/relative')).toThrow(TypeError);
  });

  it('throws a TypeError for a failNext() with an unknown reason or a times that is not a positive whole number', () => {
    const http = new HttpClientFake();
    expect(() => http.failNext('boom' as 'network')).toThrow(TypeError);
    expect(() => http.failNext('network', 0)).toThrow(TypeError);
    expect(() => http.failNext('network', 1.5)).toThrow(TypeError);
    expect(() => http.failNext('network', -1)).toThrow(TypeError);
  });
});

describe('HttpClientFake — records and assertions', () => {
  it('records the headers as sent: no content type for a raw string body, the one the client sets for json', async () => {
    const http = new HttpClientFake().respond(/.*/, new Response('ok'));
    await http.fetch('https://a.example.com/raw', { method: 'POST', body: 'hello' });
    await http.fetch('https://a.example.com/json', { method: 'POST', json: { a: 1 } });
    await http.fetch('https://a.example.com/typed', { method: 'POST', body: 'x', headers: { 'content-type': 'text/csv' } });
    expect(http.requests.map((request) => request.headers.get('content-type'))).toEqual([null, 'application/json', 'text/csv']);
  });

  it('records the request with its method, headers and body', async () => {
    const http = new HttpClientFake().respond(/.*/, new Response('ok'));
    await http.fetch('https://a.example.com/x', { method: 'POST', json: { ping: true }, headers: { 'x-key': 'k' } });
    const [request] = http.requests;
    expect([request!.method, request!.url, request!.headers.get('x-key'), request!.headers.get('content-type')]).toEqual(['POST', 'https://a.example.com/x', 'k', 'application/json']);
    expect(await request!.clone().json()).toEqual({ ping: true });
  });

  it('asserts what was sent, how many, and that nothing was', async () => {
    const http = new HttpClientFake().respond(/.*/, new Response('ok'));
    http.assertNothingSent().assertSentCount(0);
    await http.fetch('https://a.example.com/x');
    http.assertSent('https://a.example.com/x').assertSent(/a\.example/).assertSent((request) => request.method === 'GET').assertSentCount(1);
    expect(() => http.assertSent('https://b.example.com/')).toThrow(AssertionError);
    expect(() => http.assertSent((request) => request.method === 'POST')).toThrow(/Sent: GET https:\/\/a\.example\.com\/x/);
    expect(() => http.assertSentCount(2)).toThrow(/Expected 2 requests, sent 1/);
    expect(() => http.assertNothingSent()).toThrow(/Expected no request/);
  });

  it('fails the next requests after failNext() with the reason, and answers again after', async () => {
    const http = new HttpClientFake().respond(/.*/, new Response('ok')).failNext('timeout', 2);
    expect((await failure(http.fetch('https://a.example.com/'))).reason).toBe('timeout');
    expect((await failure(http.fetch('https://a.example.com/'))).reason).toBe('timeout');
    expect((await http.fetch('https://a.example.com/')).status).toBe(200);
    expect(await failure(new HttpClientFake().failNext().fetch('https://a.example.com/')).then((error) => error.reason)).toBe('network');
  });

  it('spends a failNext() on a request that passes the policy, not on a refused one', async () => {
    const http = new HttpClientFake().respond(/.*/, new Response('ok')).failNext('network');
    expect((await failure(http.fetch('http://127.0.0.1/'))).reason).toBe('refused');
    expect((await failure(http.fetch('https://a.example.com/'))).reason).toBe('network');
  });
});
