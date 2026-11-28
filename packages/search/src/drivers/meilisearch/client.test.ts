import * as fetchModule from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { describe, expect, it } from 'vitest';
import { SearchSetupError } from '../../errors.ts';
import { importFetch, MeilisearchClient, MeilisearchError, meilisearchApiKey, meilisearchUrl, SearchSyncError, type Lookup } from './client.ts';

// The trust exception: only the addresses the configured host resolves to, only for the driver's own requests, never through a
// redirect; and the start checks of the address and the key.

const KEY = 'local-test-key';
const BASE = 'http://meili.internal:7700';

function client(http: HttpClientFake, options: { lookup?: Lookup; url?: string; sleeps?: number[] } = {}): MeilisearchClient {
  let clock = 0;
  return new MeilisearchClient({
    now: () => clock,
    url: new URL(options.url ?? BASE),
    apiKey: KEY,
    http: () => http,
    fetch: () => fetchModule,
    lookup: options.lookup ?? (async () => ['10.0.0.5']),
    sleep: async (milliseconds) => {
      options.sleeps?.push(milliseconds);
      clock += milliseconds;
    },
  });
}

const rejection = async (promise: Promise<unknown>): Promise<Error> => (await promise.then(() => undefined, (error: unknown) => error)) as Error;

describe('MeilisearchClient: the host trust rule', () => {
  it('reaches the private address the configured host resolves to, with the key', async () => {
    const http = new HttpClientFake().dns('meili.internal', ['10.0.0.5']).respond(`${BASE}/version`, Response.json({ pkgVersion: '1.34.3' }));
    expect(await client(http).request('GET', ['version'])).toEqual({ pkgVersion: '1.34.3' });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('leaves the app client as it was: the same private address stays refused for every other request', async () => {
    const http = new HttpClientFake().dns('meili.internal', ['10.0.0.5']).respond(/./, Response.json({}));
    await client(http).request('GET', ['version']);
    const error = await rejection(http.fetch(`${BASE}/version`));
    expect(error).toBeInstanceOf(fetchModule.FetchError);
    expect((error as fetchModule.FetchError).reason).toBe('refused');
  });

  it('refuses another private host on a client allowed the driver\'s addresses, and builds only encoded paths of its own origin', async () => {
    const http = new HttpClientFake().dns('meili.internal', ['10.0.0.5']).dns('other.internal', ['10.0.0.6']).respond(/./, Response.json({}));
    const allowed = http.allowing(['10.0.0.5/32']);
    const error = await rejection(allowed.fetch('http://other.internal/'));
    expect((error as fetchModule.FetchError).reason).toBe('refused');
    // The driver's own client builds no address of another origin.
    expect(() => client(http).url(['..', 'x'])).toThrow(MeilisearchError);
    expect(client(http).url(['indexes', 'a/b?c#d']).href).toBe(`${BASE}/indexes/a%2Fb%3Fc%23d`);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses when the transport resolves the host to an address the lookup did not return', async () => {
    // The lookup said 10.0.0.5; the transport now sees 10.0.0.6, which the normal policy judges and refuses.
    const http = new HttpClientFake().dns('meili.internal', ['10.0.0.6']).respond(/./, Response.json({}));
    const error = await rejection(client(http).request('GET', ['version']));
    expect(error).toBeInstanceOf(MeilisearchError);
    expect((error as MeilisearchError).kind).toBe('unavailable');
    expect(error.message).toBe('The request to Meilisearch was refused by the HTTP client.');
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a redirect to a private or an external host without a second request, so the key goes nowhere else', async () => {
    for (const target of ['http://10.0.0.6/', 'https://attacker.example/collect']) {
      const http = new HttpClientFake()
        .dns('meili.internal', ['10.0.0.5'])
        .respond(/./, Response.json({ leaked: true }))
        .respond(`${BASE}/version`, new Response(null, { status: 302, headers: { location: target } }));
      const error = await rejection(client(http).request('GET', ['version']));
      expect((error as MeilisearchError).kind).toBe('unavailable');
      expect(error.message).toBe('The request to Meilisearch was answered with a redirect, which is not followed.');
      expect(http.requests.map((request) => request.url)).toEqual([`${BASE}/version`]);
    }
  });

  it('fails closed for a host that does not resolve or resolves to an entry that is no plain address', async () => {
    const http = new HttpClientFake().respond(/./, Response.json({}));
    for (const lookup of [async () => [], async () => ['fe80::1%en0'], async () => ['meili.other'], async (): Promise<string[]> => Promise.reject(new Error('ENOTFOUND')) ] as Lookup[]) {
      const error = await rejection(client(http, { lookup }).request('GET', ['version']));
      expect((error as MeilisearchError).kind).toBe('unavailable');
    }
    expect(http.requests).toHaveLength(0);
  });

  it('allows an IP literal host as its own address, IPv6 included', async () => {
    const http = new HttpClientFake().respond(/./, Response.json({ ok: true }));
    let looked = 0;
    const lookup: Lookup = async () => {
      looked++;
      return [];
    };
    expect(await client(http, { url: 'http://10.0.0.5:7700', lookup }).request('GET', ['health'])).toEqual({ ok: true });
    expect(await client(http, { url: 'http://[fd00::5]:7700', lookup }).request('GET', ['health'])).toEqual({ ok: true });
    expect(looked).toBe(0);
  });
});

describe('MeilisearchClient: answers', () => {
  const answering = (status: number, body: unknown) => new HttpClientFake().dns('meili.internal', ['10.0.0.5']).respond(/./, Response.json(body, { status }));

  it('maps index_not_found to missing-index, 401/403 to unauthorized, 5xx to unavailable, other statuses to rejected', async () => {
    const cases: [number, unknown, MeilisearchError['kind'], string][] = [
      [404, { code: 'index_not_found', message: 'Index `secret-text` not found.' }, 'missing-index', 'Meilisearch answered 404 (index_not_found).'],
      [400, { code: 'index_not_found' }, 'missing-index', 'Meilisearch answered 400 (index_not_found).'],
      [401, { code: 'missing_authorization_header' }, 'unauthorized', 'Meilisearch answered 401 (missing_authorization_header).'],
      [403, { code: 'invalid_api_key' }, 'unauthorized', 'Meilisearch answered 403 (invalid_api_key).'],
      [503, 'down', 'unavailable', 'Meilisearch answered 503.'],
      [400, { code: 'Not A Code <b>' }, 'rejected', 'Meilisearch answered 400.'],
    ];
    for (const [status, body, kind, message] of cases) {
      const error = await rejection(client(answering(status, body)).request('GET', ['indexes', 'pages']));
      expect(error).toBeInstanceOf(MeilisearchError);
      expect([(error as MeilisearchError).kind, error.message]).toEqual([kind, message]);
    }
  });

  it('maps a timeout and a network failure to unavailable', async () => {
    for (const reason of ['timeout', 'network'] as const) {
      const http = new HttpClientFake().dns('meili.internal', ['10.0.0.5']).failNext(reason);
      const error = await rejection(client(http).request('GET', ['version']));
      expect((error as MeilisearchError).kind).toBe('unavailable');
    }
  });

  it('waits for a task until it succeeded, polling with a growing pause', async () => {
    const statuses = ['enqueued', 'processing', 'processing', 'succeeded'];
    const http = new HttpClientFake().dns('meili.internal', ['10.0.0.5']).respond(`${BASE}/tasks/7`, () => Response.json({ uid: 7, status: statuses.shift() }));
    const sleeps: number[] = [];
    await client(http, { sleeps }).waitForTask({ taskUid: 7 });
    expect(sleeps).toEqual([20, 40, 80]);
    expect(http.requests).toHaveLength(4);
  });

  it('counts the time the polls take, not only the pauses, against the deadline', async () => {
    const http = new HttpClientFake().dns('meili.internal', ['10.0.0.5']).respond(`${BASE}/tasks/6`, Response.json({ uid: 6, status: 'processing' }));
    let clock = 0;
    // The clock moves 1.5 seconds between two readings, one reading per poll; the pauses add only 620 milliseconds in all.
    const slow = new MeilisearchClient({ url: new URL(BASE), apiKey: KEY, http: () => http, fetch: () => fetchModule, lookup: async () => ['10.0.0.5'], sleep: async () => {}, now: () => (clock += 1500) });
    expect((await rejection(slow.waitForTask({ taskUid: 6 }))).message).toBe('The Meilisearch task 6 did not finish within 8 seconds.');
    expect(http.requests).toHaveLength(6);
  });

  it('throws a SearchSyncError with the code, never the text, for a failed or canceled task', async () => {
    const failed = new HttpClientFake()
      .dns('meili.internal', ['10.0.0.5'])
      .respond(`${BASE}/tasks/3`, Response.json({ uid: 3, status: 'failed', error: { code: 'invalid_document_id', message: 'Document identifier `private text` is invalid.' } }));
    const error = await rejection(client(failed).waitForTask({ taskUid: 3 }));
    expect(error).toBeInstanceOf(SearchSyncError);
    expect(error.message).toBe('The Meilisearch task 3 failed (invalid_document_id).');
    expect((error as SearchSyncError).code).toBe('invalid_document_id');

    const canceled = new HttpClientFake().dns('meili.internal', ['10.0.0.5']).respond(`${BASE}/tasks/4`, Response.json({ uid: 4, status: 'canceled' }));
    expect((await rejection(client(canceled).waitForTask({ taskUid: 4 }))).message).toBe('The Meilisearch task 4 was canceled.');
  });

  it('gives up on a task that does not finish within 8 seconds of the clock, and on an answer that names no task', async () => {
    const http = new HttpClientFake().dns('meili.internal', ['10.0.0.5']).respond(`${BASE}/tasks/5`, Response.json({ uid: 5, status: 'processing' }));
    const sleeps: number[] = [];
    const error = await rejection(client(http, { sleeps }).waitForTask({ taskUid: 5 }));
    expect(error.message).toBe('The Meilisearch task 5 did not finish within 8 seconds.');
    expect(sleeps.reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(8_000);
    expect((await rejection(client(http).waitForTask({ taskUid: '5' }))).message).toBe('Meilisearch accepted a write but named no task to wait for.');
  });
});

describe('the start checks of the address and the key', () => {
  it('accepts http and https addresses at the root', () => {
    expect(meilisearchUrl('http://127.0.0.1:7700').href).toBe('http://127.0.0.1:7700/');
    expect(meilisearchUrl(' https://search.example.com/ ').href).toBe('https://search.example.com/');
  });

  it('refuses a missing address, another scheme, credentials, a query, a fragment and a path, without naming the value', () => {
    const cases: [string, RegExp][] = [
      ['', /needs SEARCH_MEILISEARCH_URL/],
      ['not an address', /is not an address/],
      ['ftp://meili.internal', /must start with http:\/\/ or https:\/\//],
      ['http://admin:hunter2-secret@meili.internal', /carries a user name or a password/],
      ['http://meili.internal/?key=hunter2-secret', /must not carry a query or a fragment/],
      ['http://meili.internal/?', /must not carry a query or a fragment/],
      ['http://meili.internal/#hunter2-secret', /must not carry a query or a fragment/],
      ['http://meili.internal/meili', /must not carry a path/],
    ];
    for (const [value, message] of cases) {
      let error: unknown;
      try {
        meilisearchUrl(value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SearchSetupError);
      expect((error as Error).message).toMatch(/^\[marmeon:Q9\] /);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain('hunter2');
    }
  });

  it('refuses a missing key and a key with control or non-ASCII characters, without naming the value, and accepts spaces', () => {
    expect(() => meilisearchApiKey('  ')).toThrow('[marmeon:Q9] SEARCH_DRIVER=meilisearch needs SEARCH_MEILISEARCH_API_KEY, the API key the app sends to Meilisearch.');
    for (const value of ['hunter2\nsecret', 'hunter2\tsecret', 'hunter2ü']) {
      let error: unknown;
      try {
        meilisearchApiKey(value);
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).toBe('[marmeon:Q9] SEARCH_MEILISEARCH_API_KEY must be printable ASCII, without line breaks or other control characters. Check the value you set.');
    }
    expect(meilisearchApiKey(' abc-123 ')).toBe('abc-123');
    // A master key may hold spaces, and Meilisearch accepts it so.
    expect(meilisearchApiKey('correct horse battery staple')).toBe('correct horse battery staple');
  });
});

describe('importFetch', () => {
  const error = (message: string, code?: string) => Object.assign(new Error(message), code === undefined ? {} : { code });

  it('is undefined only when @marmeon/fetch itself is not installed', async () => {
    expect(await importFetch(() => Promise.reject(error("Cannot find package '@marmeon/fetch' imported from x", 'ERR_MODULE_NOT_FOUND')))).toBeUndefined();
    await expect(importFetch(() => Promise.reject(error("Cannot find package 'other' imported from /app/node_modules/@marmeon/fetch/dist/index.js", 'ERR_MODULE_NOT_FOUND')))).rejects.toThrow('other');
    await expect(importFetch(() => Promise.reject(error('boom')))).rejects.toThrow('boom');
  });
});
