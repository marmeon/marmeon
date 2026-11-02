import { describe, expect, it, vi } from 'vitest';
import { PAGE_HEADER, PROTOCOL_VERSION, REGION_HEADER } from '../../protocol.ts';
import { regionTransport } from './islands.ts';

function transportFor(answer: () => Response) {
  const fetch = vi.fn(async () => answer());
  const core = {
    window: { fetch, location: { origin: 'https://app.test' } },
    left: false,
    version: undefined,
    documentChange: { change: async () => undefined },
  } as unknown as Parameters<typeof regionTransport>[0];
  return regionTransport(core);
}

const ask = (answer: () => Response) => transportFor(answer).request('/api/status', {}, new AbortController().signal);

describe('the request of an island', () => {
  it('takes a success without the island header for no island: a 404 that holds nothing of its body', async () => {
    const json = () => new Response(JSON.stringify({ message: 'secret', users: 12 }), { headers: { 'content-type': 'application/json', [PAGE_HEADER]: PROTOCOL_VERSION } });
    expect(await ask(json)).toEqual({ kind: 'exception', failure: { status: 404, message: undefined } });
    const html = () => new Response('<p>secret</p>', { headers: { 'content-type': 'text/html' } });
    expect(await ask(html)).toEqual({ kind: 'exception', failure: { status: 404, message: undefined } });
  });

  it('reads the region object of an island, and the message of an error', async () => {
    const region = { component: 'app/Members', props: {}, url: '/x', version: null };
    const island = () => new Response(JSON.stringify(region), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [REGION_HEADER]: 'island' } });
    expect(await ask(island)).toEqual({ kind: 'region', region });
    const failed = () => new Response(JSON.stringify({ message: 'No such thing.' }), { status: 404, headers: { 'content-type': 'application/json' } });
    expect(await ask(failed)).toEqual({ kind: 'exception', failure: { status: 404, message: 'No such thing.' } });
  });
});
