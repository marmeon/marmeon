import { describe, expect, it } from 'vitest';
import { HttpError } from './errors.ts';
import { createRequestState, expectsJson, type Input } from './request.ts';

const URL_BASE = 'http://app.test';

function post(path: string, body: NonNullable<RequestInit['body']>, headers: Record<string, string> = {}): Request {
  return new Request(URL_BASE + path, { method: 'POST', body, headers });
}

function form(body: string, path = '/'): Request {
  return post(path, body, { 'content-type': 'application/x-www-form-urlencoded' });
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected an HttpError');
}

describe('ctx.input()', () => {
  it('parses JSON bodies and merges the query (the body wins)', async () => {
    const request = post('/?page=2&name=query', JSON.stringify({ name: 'Ada', tags: ['a'], age: 36 }), {
      'content-type': 'application/json; charset=utf-8',
    });
    expect(await createRequestState(request).input()).toEqual({ page: '2', name: 'Ada', tags: ['a'], age: 36 });
  });

  it('parses forms with bracket notation into objects and arrays', async () => {
    const input = await createRequestState(
      form('user[name]=Ada&user[langs][]=en&user[langs][]=de&tags[0]=x&tags[1]=y&plain=1&plain=2'),
    ).input();
    expect(input).toEqual({ user: { name: 'Ada', langs: ['en', 'de'] }, tags: ['x', 'y'], plain: '2' });
  });

  it('parses multipart bodies with files and skips empty file fields', async () => {
    const body = new FormData();
    body.append('name', 'Ada');
    body.append('avatar', new File(['png-bytes'], 'ada.png', { type: 'image/png' }));
    body.append('docs[]', new File(['a'], 'a.txt'));
    const input = await createRequestState(post('/', body)).input();

    expect(input.name).toBe('Ada');
    expect(input.avatar).toBeInstanceOf(File);
    expect((input.avatar as File).name).toBe('ada.png');
    expect(await (input.avatar as File).text()).toBe('png-bytes');
    expect((input.docs as File[])[0]!.name).toBe('a.txt');
  });

  it('skips file fields without a chosen file (what browsers send: filename="")', async () => {
    // Written by hand: FormData drops the filename attribute for a nameless File, browsers do not.
    const boundary = 'b0undary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="name"',
      '',
      'Ada',
      `--${boundary}`,
      'Content-Disposition: form-data; name="avatar"; filename=""',
      'Content-Type: application/octet-stream',
      '',
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const request = post('/', body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    expect(await createRequestState(request).input()).toEqual({ name: 'Ada' });
  });

  it('parses the body once — later calls get the cached result', async () => {
    const state = createRequestState(form('a=1'));
    const first = state.input();
    expect(state.input()).toBe(first);
    expect(await first).toEqual({ a: '1' });
  });

  it('uses only the query for GET requests and non-input bodies', async () => {
    expect(await createRequestState(new Request(`${URL_BASE}/?q=ada`)).input()).toEqual({ q: 'ada' });
    expect(await createRequestState(post('/?q=ada', 'raw text', { 'content-type': 'text/plain' })).input()).toEqual({ q: 'ada' });
  });

  it('rejects bodies over the limit — by header and by actually counting', async () => {
    const big = 'x'.repeat(2048);
    const byHeader = await rejection(createRequestState(form(`a=${big}`), { maxBodySize: 1024 }).input());
    expect(byHeader.status).toBe(413);

    // A streamed body without Content-Length is counted while reading.
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new TextEncoder().encode(`a=${'x'.repeat(500)}&`));
        controller.close();
      },
    });
    const streamed = new Request(URL_BASE, {
      method: 'POST',
      body: stream,
      duplex: 'half',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    } as RequestInit);
    expect(streamed.headers.get('content-length')).toBeNull();
    expect((await rejection(createRequestState(streamed, { maxBodySize: 1024 }).input())).status).toBe(413);
  });

  it('answers malformed or non-object JSON with 400', async () => {
    const json = { 'content-type': 'application/json' };
    expect((await rejection(createRequestState(post('/', '{nope', json)).input())).message).toBe('Malformed JSON body.');
    expect((await rejection(createRequestState(post('/', '[1,2]', json)).input())).message).toBe('The JSON body must be an object.');
    expect(await createRequestState(post('/?a=1', '', json)).input()).toEqual({ a: '1' });
  });

  it('cannot be abused: no prototype pollution, no huge sparse arrays, limited depth', async () => {
    const input: Input = await createRequestState(form('__proto__[admin]=1&a[__proto__][admin]=1&ids[99999999]=1&ids[0]=2')).input();
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    expect(input.a).toEqual({});
    expect(input.ids).toEqual({ '0': '2', '99999999': '1' }); // not an array of 100 million slots

    const deep = `a${'[x]'.repeat(21)}=1`;
    expect((await rejection(createRequestState(form(deep)).input())).status).toBe(400);
  });

  it('lets a later field replace an earlier one, whatever its shape', async () => {
    expect(await createRequestState(form('a=1&a[b]=2')).input()).toEqual({ a: { b: '2' } });
    expect(await createRequestState(form('a[b]=2&a=1')).input()).toEqual({ a: '1' });
  });
});

describe('ctx.query and ctx.expectsJson()', () => {
  it('exposes the query string', () => {
    expect(createRequestState(new Request(`${URL_BASE}/users?page=2&q=a+b`)).query.get('q')).toBe('a b');
  });

  it('recognises API clients like Laravel', () => {
    const accept = (value: string, headers: Record<string, string> = {}) =>
      expectsJson(new Request(URL_BASE, { headers: { accept: value, ...headers } }));

    expect(accept('application/json')).toBe(true);
    expect(accept('application/vnd.api+json')).toBe(true);
    expect(accept('text/html,application/xhtml+xml')).toBe(false);
    expect(accept('*/*')).toBe(false);
    expect(accept('*/*', { 'x-requested-with': 'XMLHttpRequest' })).toBe(true);
  });
});
