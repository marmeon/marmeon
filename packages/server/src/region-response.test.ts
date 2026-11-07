import { REGION_HEADER, REGION_STATUS_HEADER } from '@marmeon/http/protocol';
import { describe, expect, it } from 'vitest';
import { toRegionResponse } from './render.ts';

describe('what an island request’s response becomes', () => {
  it('a success that is no island is a 404 without its body, still marked as an exception', async () => {
    const html = new Response('<p>secret</p>', { headers: { 'content-type': 'text/html' } });
    const response = await toRegionResponse(html);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(response.headers.get(REGION_STATUS_HEADER)).toBe('exception');
    expect(response.headers.has('content-type')).toBe(false);
  });

  it('an island passes as it is, and an error keeps its status', async () => {
    const island = new Response('{}', { headers: { [REGION_HEADER]: 'island', 'content-type': 'application/json' } });
    expect(await toRegionResponse(island)).toBe(island);
    expect((await toRegionResponse(new Response('boom', { status: 502 }))).status).toBe(502);
  });

  it('a 304 that carries the island header passes as it is — the browser turns it into its cached 200', async () => {
    const revalidated = new Response(null, { status: 304, headers: { [REGION_HEADER]: 'island', etag: '"v1"', 'cache-control': 'private, max-age=0' } });
    const response = await toRegionResponse(revalidated);
    expect(response.status).toBe(304);
    expect([response.headers.get('etag'), response.headers.get('cache-control'), response.headers.get(REGION_HEADER)]).toEqual(['"v1"', 'private, max-age=0', 'island']);
    expect(response.headers.has(REGION_STATUS_HEADER)).toBe(false);
  });

  it('a 304 without the island header is still the island’s `unauthorized`', async () => {
    const response = await toRegionResponse(new Response(null, { status: 304, headers: { etag: '"v1"' } }));
    expect([response.status, response.headers.get(REGION_STATUS_HEADER)]).toEqual([204, 'unauthorized']);
  });
});
