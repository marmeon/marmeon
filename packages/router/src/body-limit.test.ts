import { describe, expect, it } from 'vitest';
import { defineMiddleware, Router } from './index.ts';
import { GLOBAL } from './middleware-groups.ts';
import { createRequestState, requestBytes } from './internal.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const KB = 1024;

function post(path: string, body: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  const init: RequestInit & { duplex?: 'half' } = { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } };
  if (body instanceof ReadableStream) init.duplex = 'half';
  return new Request(`http://app.test${path}`, init);
}

/** A body of `size` bytes sent in chunks, without a Content-Length — what chunked transfer encoding gives the app. */
function chunked(size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) return controller.close();
      const chunk = Math.min(256, size - sent);
      sent += chunk;
      controller.enqueue(new TextEncoder().encode('x'.repeat(chunk)));
    },
  });
}

const seen: number[] = [];
const reader = defineMiddleware('reader', async (ctx, next) => {
  seen.push((await requestBytes(ctx.request)).byteLength);
  return next();
});

const mark = defineMiddleware('mark', (_ctx, next) => (seen.push(-1), next()));

const router = new Router().load(
  openRoutes((Route) => {
    Route.post('/echo', async (ctx) => ({ size: (await requestBytes(ctx.request)).byteLength })).name('echo');
    Route.post('/small', async (ctx) => ({ size: (await requestBytes(ctx.request)).byteLength })).maxBodyBytes(KB).name('small');
    Route.maxBodyBytes(4 * KB).group((Route) => {
      Route.post('/group-big', async (ctx) => ({ size: (await requestBytes(ctx.request)).byteLength })).name('group.big');
      Route.post('/group-small', async (ctx) => ({ size: (await requestBytes(ctx.request)).byteLength })).maxBodyBytes(KB).name('group.small');
    });
    Route.maxBodyBytes(KB).group((Route) => {
      Route.post('/narrow-group', async (ctx) => ({ size: (await requestBytes(ctx.request)).byteLength })).maxBodyBytes(4 * KB).name('narrow.group');
    });
    Route.middleware(mark).post('/marked', () => 'handled').maxBodyBytes(KB).name('marked');
    Route.middleware(reader).post('/behind-middleware', () => 'handled').maxBodyBytes(KB).name('behind');
  }),
);

async function send(name: string, request: Request, serverLimit?: number): Promise<{ status: number; body: unknown }> {
  const route = router.routes.find((candidate) => candidate.routeName === name)!;
  const state = createRequestState(request, serverLimit === undefined ? {} : { maxBodyBytes: serverLimit });
  const response = await router.dispatch(route, { request, params: {} }, {
    state,
    onError: (error) => new Response(JSON.stringify({ message: (error as Error).message }), { status: (error as { status?: number }).status ?? 500 }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

describe('Route.maxBodyBytes()', () => {
  it('refuses a body over the route\'s limit with a 413 and lets one within it pass', async () => {
    const refused = await send('small', post('/small', 'a='.padEnd(2 * KB, 'x')));
    expect(refused).toEqual({ status: 413, body: { message: `The request body exceeds ${KB} bytes.` } });
    expect(await send('small', post('/small', 'a='.padEnd(KB, 'x')))).toEqual({ status: 200, body: { size: KB } });
  });

  it('does not touch a route without a limit', async () => {
    expect((await send('echo', post('/echo', 'a='.padEnd(2 * KB, 'x')))).status).toBe(200);
  });

  it('holds a chunked body without a Content-Length to the limit', async () => {
    const request = post('/small', chunked(2 * KB));
    expect(request.headers.get('content-length')).toBeNull();
    expect((await send('small', request)).status).toBe(413);
    expect((await send('small', post('/small', chunked(KB)))).status).toBe(200);
  });

  it('holds a body that lies about its Content-Length', async () => {
    expect((await send('small', post('/small', chunked(2 * KB), { 'content-length': '10' }))).status).toBe(413);
  });

  it('refuses a declared Content-Length over the limit without reading', async () => {
    const request = post('/small', new ReadableStream({ pull() { throw new Error('read'); } }), { 'content-length': String(2 * KB) });
    expect((await send('small', request)).status).toBe(413);
  });

  it('holds a multipart body to the limit', async () => {
    const data = new FormData();
    data.set('note', 'x'.repeat(2 * KB));
    // Encoded up front: undici pumps a FormData body on its own, and cancelling that pump mid-way is a Node warning, not the app's.
    const encoded = new Response(data);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    expect((await send('small', post('/small', bytes, { 'content-type': encoded.headers.get('content-type')! }))).status).toBe(413);
  });

  it('applies the smaller of the group\'s limit and the route\'s, whichever is declared last', async () => {
    const body = (size: number) => post('/x', 'a='.padEnd(size, 'x'));
    expect((await send('group.big', body(3 * KB))).status).toBe(200);
    expect((await send('group.big', body(5 * KB))).status).toBe(413);
    expect((await send('group.small', body(2 * KB))).status).toBe(413);
    expect((await send('narrow.group', body(2 * KB))).status).toBe(413);
    expect((await send('narrow.group', body(KB))).status).toBe(200);
  });

  it('never raises the server\'s limit', async () => {
    const refused = await send('group.big', post('/x', 'a='.padEnd(KB, 'x')), 512);
    expect(refused).toEqual({ status: 413, body: { message: 'The request body exceeds 512 bytes.' } });
  });

  it('applies before the route\'s middleware: it never sees an oversized body', async () => {
    seen.length = 0;
    expect((await send('behind', post('/x', 'a='.padEnd(2 * KB, 'x')))).status).toBe(413);
    expect(seen).toEqual([]);
    expect((await send('behind', post('/x', 'a=1'))).status).toBe(200);
    expect(seen).toEqual([3]);
  });

  it('answers a declared length over the limit before any middleware runs, and sets no cookie', async () => {
    const log: string[] = [];
    const trace = (name: string) => defineMiddleware(name, (_ctx, next) => (log.push(name), next()));
    const guarded = new Router();
    guarded.middleware.append(GLOBAL, trace('global')).append('web', trace('group'));
    guarded.load({ group: 'web' }, openRoutes((Route) => Route.middleware(trace('route')).post('/x', async (ctx) => (await requestBytes(ctx.request), 'ok')).maxBodyBytes(KB).name('x')));
    const route = guarded.routes[0]!;
    const refuse = (error: unknown) => new Response(null, { status: (error as { status: number }).status });
    const request = () => post('/x', 'a='.padEnd(2 * KB, 'x'), { 'content-length': String(2 * KB) });
    const response = await guarded.dispatch(route, { request: request(), params: {} }, { onError: refuse });
    expect([response.status, response.headers.getSetCookie(), log]).toEqual([413, [], []]);
    // A declared length that is no plain number is not trusted; the read counts the bytes instead.
    const odd = await guarded.dispatch(route, { request: post('/x', 'a='.padEnd(2 * KB, 'x'), { 'content-length': '0x10' }), params: {} }, { onError: refuse });
    expect(odd.status).toBe(413);
  });

  it('answers with the error of a read that failed before the match', async () => {
    const request = post('/small', 'a='.padEnd(2 * KB, 'x'));
    const state = createRequestState(request, { maxBodyBytes: 512 });
    await requestBytes(request).catch(() => undefined);
    seen.length = 0;
    const route = router.routes.find((candidate) => candidate.routeName === 'marked')!;
    const response = await router.dispatch(route, { request, params: {} }, { state, onError: (error) => new Response(null, { status: (error as { status: number }).status }) });
    expect([response.status, seen]).toEqual([413, []]);
  });

  it('refuses a multipart body something read before the match that is over the limit', async () => {
    const data = new FormData();
    data.set('note', 'x'.repeat(4 * KB));
    const encoded = new Response(data);
    const request = post('/small', new Uint8Array(await encoded.arrayBuffer()), { 'content-type': encoded.headers.get('content-type')! });
    const state = createRequestState(request);
    await state.input();
    // A second read after the multipart one fails on the taken stream; it must not hide the size of the first.
    await requestBytes(request).catch(() => undefined);
    const route = router.routes.find((candidate) => candidate.routeName === 'small')!;
    const response = await router.dispatch(route, { request, params: {} }, { state, onError: (error) => new Response(null, { status: (error as { status: number }).status }) });
    expect(response.status).toBe(413);
  });

  it('refuses a body something read before the match that is over the limit', async () => {
    const request = post('/small', 'a='.padEnd(2 * KB, 'x'));
    const state = createRequestState(request);
    await state.input();
    const route = router.routes.find((candidate) => candidate.routeName === 'small')!;
    const response = await router.dispatch(route, { request, params: {} }, { state, onError: (error) => new Response(null, { status: (error as { status: number }).status }) });
    expect(response.status).toBe(413);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1024' as unknown as number])('refuses %s at definition', (bytes) => {
    expect(() => new Router().load(openRoutes((Route) => Route.post('/x', () => 'x').maxBodyBytes(bytes)))).toThrow(TypeError);
    expect(() => new Router().load(openRoutes((Route) => Route.maxBodyBytes(bytes)))).toThrow(TypeError);
  });

  it('cannot change after the routes were loaded', () => {
    const route = router.routes[0]!;
    expect(() => route.maxBodyBytes(KB)).toThrow(/cannot change a route/);
  });
});
