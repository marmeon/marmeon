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
});
