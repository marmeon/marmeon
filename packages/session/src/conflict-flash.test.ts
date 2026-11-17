import { createApplication, defineModule, Translator } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { conflict, HttpServiceProvider, view, type PageObject } from '@marmeon/http';
import { DOCUMENT_HEADER, SUBMIT_HEADER } from '@marmeon/http/internal';
import { FLASH_WAITING_HEADER, PAGE_HEADER, VERSION_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { createHttpKernel } from '@marmeon/server';
import { describe, expect, it } from 'vitest';
import { SessionServiceProvider } from './provider.ts';
import { SessionStore } from './store.ts';
import { MemorySessionStore } from './stores/memory.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { wrapped } from './test-helpers/wrapped-store.ts';

const routes = openRoutes((Route) => {
  Route.post('/notes/1', () => conflict({ updatedAt: 'T2' }, { message: 'Edited by Ada.' }));
  Route.post('/notes/huge', () => conflict({ document: 'x'.repeat(70_000) }, { message: 'Too big to keep.' }));
  Route.post('/notes/cycle', () => {
    const current: Record<string, unknown> = { updatedAt: 'T2' };
    current.self = current;
    return conflict(current);
  });
  Route.get('/notes/page', () => view('notes/Edit', { note: 'current' }));
  Route.post('/notes/huge-message', () => conflict({ updatedAt: 'T2' }, { message: 'x'.repeat(200_000) }));
  Route.post('/notes/stateful', () => {
    let calls = 0;
    return conflict({ toJSON: () => (++calls === 1 ? { updatedAt: 'T2' } : { document: 'x'.repeat(200_000) }) }, { message: 'Edited by Ada.' });
  });
  Route.post('/notes/almost', () => conflict({ document: 'x'.repeat(1000) }, { message: 'm'.repeat(65_534) }));
  Route.post('/notes/accents', () => conflict(undefined, { message: 'é'.repeat(100_000) }));
  Route.post('/notes/emoji', () => conflict(undefined, { message: '😀'.repeat(60_000) }));
  Route.post('/notes/ok', () => ({ ok: true }));
  Route.get('/notes/own', () => view('notes/Edit', { note: 'current', _conflict: { message: 'Faked.' } } as never));
  Route.get('/notes/conflicting', () => conflict({ updatedAt: 'T2' }));
});

const GERMAN: Record<string, string> = { 'marmeon.errors.conflict': 'Jemand anderes hat das inzwischen geändert.' };

const apiRoutes = openRoutes((Route) => {
  Route.put('/notes/1', () => conflict({ updatedAt: 'T2' }));
});

async function boot(store?: SessionStore, translated = false, assetVersion?: string) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
    modules: [defineModule({ name: 'notes', routes, apiRoutes })],
  }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent' }, override: (container) => {
      if (store) container.instance(SessionStore, store);
      if (translated) container.scoped(Translator, () => ({ locale: 'de', has: (key: string) => key in GERMAN, text: (key: string, _params: unknown, fallback?: string) => GERMAN[key] ?? fallback ?? key }) as never);
    } });
  const kernel = createHttpKernel(application, assetVersion === undefined ? {} : { assetVersion });
  const jar = new Map<string, string>();
  return async (path: string, init: { method?: string; headers?: Record<string, string>; body?: RequestInit['body'] } = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await kernel.request(path, { ...init, headers: { cookie, ...init.headers } });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, value] = pair!.split('=') as [string, string];
      jar.set(name, value);
    }
    return response;
  };
}

const VISIT = { [PAGE_HEADER]: PROTOCOL_VERSION, 'sec-fetch-site': 'same-origin', referer: 'http://localhost/notes/page' };
const submit = (headers: Record<string, string>) => ({ method: 'POST', headers, body: new URLSearchParams({ title: 'Mine' }) });
const props = async (response: Response) => ((await response.json()) as PageObject).props as Record<string, unknown>;

describe('a form that is answered with conflict(current)', () => {
  it('goes back with 303; the next page carries { message, current }, the one after carries none', async () => {
    const send = await boot();
    const back = await send('/notes/1', submit(VISIT));
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe('/notes/page');
    const next = await props(await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } }));
    expect(next).toMatchObject({ note: 'current', _conflict: { message: 'Edited by Ada.', current: { updatedAt: 'T2' } } });
    const after = await props(await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } }));
    expect(after.note).toBe('current');
    expect(after._conflict, 'the flash was kept').toBeNull();
  });

  it('does the same for a form posted without JavaScript — and a page without a conflict has `conflict: null`', async () => {
    const send = await boot();
    const plain = await props(await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } }));
    expect(plain.note).toBe('current');
    expect(plain._conflict).toBeNull();
    const back = await send('/notes/1', submit({ accept: 'text/html', 'sec-fetch-site': 'same-origin', referer: 'http://localhost/notes/page' }));
    expect(back.status).toBe(303);
    expect(await props(await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } }))).toMatchObject({ _conflict: { message: 'Edited by Ada.' } });
  });

  it('keeps the message and leaves `current` out when it is over 64 KiB, or no JSON can hold it', async () => {
    for (const path of ['/notes/huge', '/notes/cycle']) {
      const send = await boot();
      expect((await send(path, submit(VISIT))).status).toBe(303);
      const next = await props(await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } }));
      expect(next._conflict, path).toBeTypeOf('object');
      const kept = next._conflict as { message: string };
      expect(kept.message).toBe(path === '/notes/huge' ? 'Too big to keep.' : 'Someone else changed this in the meantime.');
      expect(kept).not.toHaveProperty('current');
    }
  });

  it('waits for the page the user is shown: a prefetch and another tab’s request in between leave it where it is', async () => {
    const send = await boot();
    expect((await send('/notes/1', submit({ ...VISIT, [DOCUMENT_HEADER]: 'tab-a' }))).status).toBe(303);
    const visit = (headers: Record<string, string>) => send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, ...headers } });
    for (const between of [{ purpose: 'prefetch' } as Record<string, string>, { 'sec-purpose': 'prefetch' }, { [DOCUMENT_HEADER]: 'tab-b' }]) {
      expect((await props(await visit(between)))._conflict, JSON.stringify(between)).toBeNull();
    }
    const shown = await props(await visit({ [DOCUMENT_HEADER]: 'tab-a' }));
    expect(shown._conflict).toMatchObject({ message: 'Edited by Ada.', current: { updatedAt: 'T2' } });
    expect((await props(await visit({ [DOCUMENT_HEADER]: 'tab-a' })))._conflict).toBeNull();
  });

  it('is `null` on a partial reload that leaves it out: the browser keeps no old conflict', async () => {
    const send = await boot();
    const partial = { [PAGE_HEADER]: PROTOCOL_VERSION, [PARTIAL_COMPONENT_HEADER]: 'notes/Edit', [PARTIAL_DATA_HEADER]: 'note' };
    expect((await send('/notes/1', submit(VISIT))).status).toBe(303);
    expect((await props(await send('/notes/page', { headers: partial })))._conflict).toMatchObject({ message: 'Edited by Ada.' });
    const again = await props(await send('/notes/page', { headers: partial }));
    expect(again).toHaveProperty('_conflict', null);
  });

  it('speaks the request’s language in the flash, goes to the fallback without a Referer, and keeps going back when the body cannot be read', async () => {
    const send = await boot(undefined, true);
    const { referer: _referer, ...withoutReferer } = VISIT;
    const response = await send('/notes/1', { method: 'POST', headers: { ...withoutReferer, 'content-type': 'application/json' }, body: '{ not json' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    const next = await props(await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } }));
    expect(next._conflict).toMatchObject({ message: 'Edited by Ada.' });
    const plain = await send('/notes/cycle', { method: 'POST', headers: { ...withoutReferer, 'content-type': 'application/json' }, body: '{}' });
    expect(plain.status).toBe(303);
    expect((await props(await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } })) as { _conflict: { message: string } })._conflict.message).toBe('Jemand anderes hat das inzwischen geändert.');
  });

  it('is refused with 406 for a GET — a prefetch or a link — and writes nothing to the session', async () => {
    const memory = new MemorySessionStore();
    const written: string[] = [];
    const send = await boot(wrapped(memory, { write: (key, data, options) => (written.push(data), memory.write(key, data, options)) }));
    for (const headers of [{ [PAGE_HEADER]: PROTOCOL_VERSION, purpose: 'prefetch' } as Record<string, string>, { accept: 'text/html' }]) {
      const response = await send('/notes/conflicting', { headers });
      expect(response.status).toBe(406);
      expect(response.headers.get('location')).toBeNull();
    }
    expect(written.filter((data) => data.includes('Someone else'))).toEqual([]);
  });

  it('flashes the input with it, so the form refills — never the secret fields', async () => {
    const memory = new MemorySessionStore();
    const written: string[] = [];
    const send = await boot(wrapped(memory, { write: (key, data, options) => (written.push(data), memory.write(key, data, options)) }));
    const body = new URLSearchParams({ title: 'Mine', password: 'hunter2-secret' });
    expect((await send('/notes/1', { method: 'POST', headers: VISIT, body })).status).toBe(303);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('Mine');
    expect(written[0]).not.toContain('hunter2-secret');
  });

  it('waits for the follow-up of its own submit: a poll, a partial reload or a prefetch of the same document in between do not take it', async () => {
    const send = await boot();
    const own = { ...VISIT, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 'submit-1' };
    expect((await send('/notes/1', submit(own))).status).toBe(303);
    const inBetween: Record<string, string>[] = [
      { [PAGE_HEADER]: PROTOCOL_VERSION, [DOCUMENT_HEADER]: 'tab-a' },
      { [PAGE_HEADER]: PROTOCOL_VERSION, [DOCUMENT_HEADER]: 'tab-a', [PARTIAL_COMPONENT_HEADER]: 'notes/Edit', [PARTIAL_DATA_HEADER]: 'note' },
      { [PAGE_HEADER]: PROTOCOL_VERSION, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 'submit-2' },
    ];
    for (const headers of inBetween) {
      const response = await send('/notes/page', { headers });
      expect((await props(response))._conflict, JSON.stringify(headers)).toBeNull();
    }
    // A prefetch takes nothing.
    const prefetch = await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [DOCUMENT_HEADER]: 'tab-a', purpose: 'prefetch' } });
    expect((await props(prefetch))._conflict).toBeNull();
    const followed = await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 'submit-1' } });
    expect(followed.headers.get('cache-control')).toBe('no-store');
    expect((await props(followed))._conflict).toMatchObject({ message: 'Edited by Ada.' });
    expect((await props(await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 'submit-1' } })))._conflict).toBeNull();
  });

  it('is ended by a later submit of the same document that does not answer it — and not by another document’s', async () => {
    const send = await boot();
    const submitted = (document: string, id: string) => ({ ...VISIT, [DOCUMENT_HEADER]: document, [SUBMIT_HEADER]: id });
    const followUp = (document: string, id: string) => send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [DOCUMENT_HEADER]: document, [SUBMIT_HEADER]: id } });
    const ok = (document: string, id: string) => send('/notes/ok', { ...submit(submitted(document, id)), headers: { ...submitted(document, id), accept: 'application/json' } });
    expect((await send('/notes/1', submit(submitted('tab-a', 's1')))).status).toBe(303);
    // Another document’s submit ends nothing of tab A’s: its follow-up still takes the conflict.
    await ok('tab-b', 's2');
    expect((await props(await followUp('tab-a', 's1')))._conflict).toMatchObject({ message: 'Edited by Ada.' });
    // The same document’s next submit that answers no conflict ends the waiting one.
    expect((await send('/notes/1', submit(submitted('tab-a', 's3')))).status).toBe(303);
    await ok('tab-a', 's4');
    expect((await props(await followUp('tab-a', 's3')))._conflict, 'the next form’s submit ended it').toBeNull();
  });

  it('keeps the conflicts of two tabs within one round trip: each follow-up takes its own, whatever the order', async () => {
    const send = await boot();
    const submitted = (document: string, id: string) => ({ ...VISIT, [DOCUMENT_HEADER]: document, [SUBMIT_HEADER]: id });
    const followUp = (document: string, id: string) => send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [DOCUMENT_HEADER]: document, [SUBMIT_HEADER]: id } });
    expect((await send('/notes/1', submit(submitted('tab-a', 'a1')))).status).toBe(303);
    expect((await send('/notes/huge', submit(submitted('tab-b', 'b1')))).status).toBe(303);
    expect((await props(await followUp('tab-b', 'b1')))._conflict).toMatchObject({ message: 'Too big to keep.' });
    expect((await props(await followUp('tab-a', 'a1')))._conflict).toMatchObject({ message: 'Edited by Ada.', current: { updatedAt: 'T2' } });
  });

  it('releases the binding to the submit when its follow-up is answered with the asset-version 409: the full document load takes the conflict', async () => {
    const send = await boot(undefined, false, 'v2');
    const own = { [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' };
    expect((await send('/notes/1', submit({ ...VISIT, ...own, [VERSION_HEADER]: 'v2' }))).status).toBe(303);
    const stale = await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [VERSION_HEADER]: 'v1', ...own } });
    expect(stale.status).toBe(409);
    // A full load names no document and sends no id: it takes it.
    const full = await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
    expect((await props(full))._conflict).toMatchObject({ message: 'Edited by Ada.' });
  });

  it('makes a prefetch wait for a conflict whether it is bound to a submit or not — but not one of another document', async () => {
    const send = await boot();
    const prefetch = (document: string) => send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [DOCUMENT_HEADER]: document, purpose: 'prefetch' } });
    expect((await prefetch('tab-a')).headers.get(FLASH_WAITING_HEADER)).toBeNull();
    expect((await send('/notes/1', submit({ ...VISIT, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' }))).status).toBe(303);
    expect((await prefetch('tab-a')).headers.get(FLASH_WAITING_HEADER)).toBe('true');
    expect((await prefetch('tab-b')).headers.get(FLASH_WAITING_HEADER)).toBeNull();
  });

  it('stores what it measured, whole, at most 64 KiB: a toJSON that answers differently the second time, a message that nearly fills it, multi-byte text', async () => {
    const memory = new MemorySessionStore();
    const written: string[] = [];
    const send = await boot(wrapped(memory, { write: (key, data, options) => (written.push(data), memory.write(key, data, options)) }));
    const stored = async (path: string) => {
      expect((await send(path, submit(VISIT))).status, path).toBe(303);
      const next = (await props(await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } })))._conflict as { message: string; current?: unknown };
      return next;
    };
    // The first serialization fits: that string is what is kept, not a second call's.
    expect(await stored('/notes/stateful')).toEqual({ message: 'Edited by Ada.', current: { updatedAt: 'T2' } });
    for (const path of ['/notes/almost', '/notes/accents', '/notes/emoji']) {
      const kept = await stored(path);
      expect(Buffer.byteLength(JSON.stringify(kept)), path).toBeLessThanOrEqual(65_536);
      expect(kept, path).not.toHaveProperty('current');
    }
    const emoji = (await stored('/notes/emoji')).message;
    // Cut between characters: no half of a pair is left, and the text is whole emoji up to the cut.
    expect(emoji.endsWith('…')).toBe(true);
    expect(emoji.slice(0, -1)).toMatch(/^(😀)+$/u);
    expect((await stored('/notes/accents')).message.slice(0, -1)).toMatch(/^é+$/);
  });

  it('keeps one conflict where nothing tells forms apart, however many stale posts come, and bounds an oversized message', async () => {
    const memory = new MemorySessionStore();
    const written: string[] = [];
    const send = await boot(wrapped(memory, { write: (key, data, options) => (written.push(data), memory.write(key, data, options)) }));
    // No document and no submit id: nothing but the cap limits what waits.
    for (let n = 0; n < 25; n++) expect((await send('/notes/1', submit(VISIT))).status).toBe(303);
    expect(written.at(-1)!.match(/Edited by Ada\./g)).toHaveLength(1);
    expect((await send('/notes/huge-message', submit(VISIT))).status).toBe(303);
    expect(written.at(-1)!.length).toBeLessThan(2 * 65_536);
    const next = await props(await send('/notes/page', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } }));
    expect((next._conflict as { message: string }).message.length).toBeGreaterThan(1000);
    expect((next._conflict as { message: string }).message.endsWith('…')).toBe(true);
  });

  it('an API-group route (no session) answers a page request with 406 and no cookie — never a redirect, a failure or a session', async () => {
    const send = await boot();
    for (const headers of [{ [PAGE_HEADER]: PROTOCOL_VERSION }, { accept: 'text/html' }, { ...VISIT, accept: 'text/html' }] as Record<string, string>[]) {
      const response = await send('/api/notes/1', { method: 'PUT', headers });
      expect(response.status, JSON.stringify(headers)).toBe(406);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    // The API client that asks for JSON gets the 409.
    expect((await send('/api/notes/1', { method: 'PUT', headers: { accept: 'application/json' } })).status).toBe(409);
  });

  it('drops a page’s own `_conflict` prop: it neither fakes a conflict nor hides the real one', async () => {
    const send = await boot();
    const visit = { [PAGE_HEADER]: PROTOCOL_VERSION };
    expect((await props(await send('/notes/own', { headers: visit })))._conflict).toBeNull();
    expect((await send('/notes/1', submit(VISIT))).status).toBe(303);
    expect((await props(await send('/notes/own', { headers: visit })))._conflict).toMatchObject({ message: 'Edited by Ada.' });
  });
});
