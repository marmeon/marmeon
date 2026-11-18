import { HttpClientFake } from '@marmeon/fetch/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthSetupError } from './config.ts';
import type { OAuthHttp } from './definition.ts';
import { createOAuthHttp, OAuthHttpError } from './http.ts';

const URL_ = 'https://api.example.com/user';
const failure = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe('OAuthHttp', () => {
  afterEach(() => void vi.useRealTimers());

  it('gives up after ten seconds', async () => {
    vi.useFakeTimers();
    const client = new HttpClientFake().respond(URL_, () => new Promise<Response>(() => {}));
    const pending = failure(createOAuthHttp(client, false).json(URL_));
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(OAuthHttpError);
    expect((error as OAuthHttpError).status).toBe(0);
  });

  it('sends a bearer token and a form', async () => {
    const client = new HttpClientFake().respond(URL_, Response.json({ ok: 1 }));
    const http = createOAuthHttp(client, false);
    expect(await http.json(URL_, { bearer: 'tok', headers: { Accept: 'text/html', 'x-extra': 'y' } })).toEqual({ ok: 1 });
    expect(await http.json(URL_, { form: { code: 'c', grant_type: 'authorization_code' } })).toEqual({ ok: 1 });
    const [get, post] = client.requests;
    expect(get!.method).toBe('GET');
    expect(get!.headers.get('authorization')).toBe('Bearer tok');
    expect(get!.headers.get('accept')).toBe('application/json');
    expect(get!.headers.get('x-extra')).toBe('y');
    expect(post!.method).toBe('POST');
    expect(post!.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
    expect(post!.headers.get('authorization')).toBeNull();
    expect(await post!.clone().text()).toBe('code=c&grant_type=authorization_code');
  });

  it('refuses to follow a redirect', async () => {
    const client = new HttpClientFake()
      .respond(URL_, new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/steal' } }))
      .respond('https://elsewhere.example.com/steal', Response.json({ leaked: true }));
    const error = await failure(createOAuthHttp(client, false).json(URL_, { bearer: 'tok' }));
    expect(error).toBeInstanceOf(OAuthHttpError);
    expect((error as OAuthHttpError).status).toBe(0);
    client.assertSentCount(1);
  });

  it('stops at maxBytes', async () => {
    const client = new HttpClientFake().respond(URL_, new Response(JSON.stringify({ pad: 'x'.repeat(2000) })));
    const http = createOAuthHttp(client, false);
    const error = await failure(http.json(URL_, { maxBytes: 100 }));
    expect(error).toBeInstanceOf(OAuthHttpError);
    expect((error as OAuthHttpError).status).toBe(0);
    expect(await http.json(URL_, { maxBytes: 4000 })).toMatchObject({ pad: expect.any(String) });
    // The default is 1 MiB.
    client.respond(URL_, new Response(`{"pad":"${'x'.repeat(1024 * 1024)}"}`));
    expect(await failure(http.json(URL_))).toBeInstanceOf(OAuthHttpError);
  });

  it('reports a 4xx with its status and never its body', async () => {
    const secret = 'SECRET-BODY-VALUE';
    const client = new HttpClientFake().respond(URL_, new Response(JSON.stringify({ error: secret }), { status: 403 }));
    const error = await failure(createOAuthHttp(client, false).json(URL_, { bearer: 'tok' }));
    expect(error).toBeInstanceOf(OAuthHttpError);
    expect((error as OAuthHttpError).status).toBe(403);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain('tok');
    for (const status of [401, 404, 500, 503]) {
      client.respond(URL_, new Response('x', { status }));
      expect(((await failure(createOAuthHttp(client, false).json(URL_))) as OAuthHttpError).status).toBe(status);
    }
  });

  it('reports an answer that is no JSON with status 0 and without a piece of it', async () => {
    const client = new HttpClientFake().respond(URL_, new Response('<html>SECRET-PAGE</html>'));
    const error = (await failure(createOAuthHttp(client, false).json(URL_))) as OAuthHttpError;
    expect(error).toBeInstanceOf(OAuthHttpError);
    expect(error.status).toBe(0);
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain('SECRET-PAGE');
  });

  it('reports a request that fails with status 0', async () => {
    const client = new HttpClientFake().respond(URL_, Response.json({})).failNext('timeout');
    const error = await failure(createOAuthHttp(client, false).json(URL_));
    expect(error).toBeInstanceOf(OAuthHttpError);
    expect((error as OAuthHttpError).status).toBe(0);
  });

  it('reaches a private range only through allowAddresses', async () => {
    const url = 'https://idp.corp.example/user';
    const client = new HttpClientFake().respond(url, Response.json({ ok: 1 })).dns('idp.corp.example', ['10.20.0.5']);
    const refused = await failure(createOAuthHttp(client, false).json(url));
    expect(refused).toBeInstanceOf(OAuthHttpError);
    client.assertNothingSent();
    expect(await createOAuthHttp(client.allowing(['10.20.0.0/16']), false).json(url)).toEqual({ ok: 1 });
    // A range that does not cover the address changes nothing, and neither does the client the allowance came from.
    expect(await failure(createOAuthHttp(client.allowing(['10.30.0.0/16']), false).json(url))).toBeInstanceOf(OAuthHttpError);
    expect(await failure(createOAuthHttp(client, false).json(url))).toBeInstanceOf(OAuthHttpError);
  });

  it('sends a bearer token to https only, and to a loopback host only while developing', async () => {
    const client = new HttpClientFake().respond(/.*/, Response.json({}));
    for (const url of ['http://api.example.com/user', 'ftp://api.example.com/user', 'https://u:p@api.example.com/user', '/user']) {
      expect(await failure(createOAuthHttp(client, true).json(url, { bearer: 'tok' })), url).toBeInstanceOf(OAuthSetupError);
    }
    expect(await failure(createOAuthHttp(client, false).json('http://localhost:9000/user', { bearer: 'tok' }))).toBeInstanceOf(OAuthSetupError);
    // The address policy still applies to a loopback host: it is reached only when it is allowed.
    expect(await createOAuthHttp(client.allowing(['127.0.0.0/8']), true).json('http://127.0.0.1:9000/user', { bearer: 'tok' })).toEqual({});
    client.assertSentCount(1);
  });

  it('refuses a bearer token that cannot be a header value, without naming it in the message', async () => {
    const client = new HttpClientFake().respond(URL_, Response.json({}));
    const token = 'tok-SECRET\nInjected: yes';
    const inits: Parameters<OAuthHttp['json']>[1][] = [{ bearer: token }, { headers: { 'x-a': token } }, { headers: { 'bad name': 'x' } }];
    for (const init of inits) {
      const error = await failure(createOAuthHttp(client, false).json(URL_, init));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).not.toContain('SECRET');
      expect((error as Error).cause).toBeUndefined();
    }
    client.assertNothingSent();
  });
});
