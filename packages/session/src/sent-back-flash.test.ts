import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { conflict, Controller, HttpServiceProvider, RedirectResult, ValidationError, view, type PageObject } from '@marmeon/http';
import { DOCUMENT_HEADER, SUBMIT_HEADER } from '@marmeon/http/internal';
import { FLASH_WAITING_HEADER, PAGE_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PROTOCOL_VERSION, VERSION_HEADER } from '@marmeon/http/protocol';
import { createHttpKernel } from '@marmeon/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionServiceProvider } from './provider.ts';
import { Session } from './session.ts';
import { SessionStore } from './store.ts';
import { MemorySessionStore } from './stores/memory.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { wrapped } from './test-helpers/wrapped-store.ts';

class EditController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    return view('notes/Edit', { old: this.#session.old() });
  }
}

class OwnErrorsController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.flashData('errors', { title: ['Own.'] });
    return new RedirectResult().back();
  }
}

/** A controller that flashes by hand, in the ways other than `withErrors()`/`withInput()`, then sends the form back. */
class ByHandController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle(ctx: { request: Request }) {
    const how = new URL(ctx.request.url).searchParams.get('how');
    const back = new RedirectResult().back();
    if (how === 'errors-then-input') {
      this.#session.flashData('errors', { title: ['Own.'] });
      return back.withInput({ title: 'typed' });
    }
    if (how === 'input-then-errors') {
      this.#session.flashInput({ title: 'typed' });
      return back.withErrors({ title: ['Required.'] });
    }
    if (how === 'string-message') return back.with('errors', { title: 'Taken.' }).withInput({ title: 'typed' });
    if (how === 'not-a-record') return back.with('errors', 'broken').withInput({ title: 'typed' });
    throw new Error(`unknown ${String(how)}`);
  }
}

/** A controller that flashes by hand and answers with a plain response: nothing of it is a record. */
class PlainFlashController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.flashData('errors', { title: ['Own.'] });
    this.#session.flashInput({ title: 'own input' });
    return new Response(null, { status: 303, headers: { location: '/notes/page' } });
  }
}

/** A page that keeps flash data that is not there, and one that flashes errors that are no record. */
class KeepController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle(ctx: { request: Request }) {
    if (new URL(ctx.request.url).searchParams.has('broken')) this.#session.flashData('errors', 'broken' as never);
    else this.#session.keep('errors', '_old_input');
    return view('notes/Edit', { old: this.#session.old() });
  }
}

/** A page that flashes input of its own in the request that shows it. */
class FreshInputController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.flashInput({ fresh: 'x' });
    return view('notes/Edit', { old: this.#session.old() });
  }
}

const routes = openRoutes((Route) => {
  Route.post('/notes/1', () => {
    throw new ValidationError({ title: ['Required.'] }, { title: '', password: 'x' });
  });
  Route.post('/notes/ok', () => ({ ok: true }));
  Route.post('/notes/own', OwnErrorsController);
  Route.post('/notes/by-hand', ByHandController);
  Route.post('/notes/plain', PlainFlashController);
  Route.post('/notes/stale', () => conflict({ v: 1 }));
  Route.post('/notes/saved', EditController);
  Route.get('/notes/keep', KeepController);
  Route.get('/notes/fresh', FreshInputController);
  Route.get('/notes/page', EditController);
});

async function boot(store?: SessionStore, assetVersion?: string) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
    modules: [defineModule({ name: 'notes', routes })],
  }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent' }, override: (container) => {
      if (store) container.instance(SessionStore, store);
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
const NO_SCRIPT = { accept: 'text/html', 'sec-fetch-site': 'same-origin', referer: 'http://localhost/notes/page' };
const PAGE = { [PAGE_HEADER]: PROTOCOL_VERSION };
const submit = (headers: Record<string, string>) => ({ method: 'POST', headers, body: new URLSearchParams({ title: '', password: 'x' }) });
const props = async (response: Response) => {
  const { errors, old, _conflict } = ((await response.json()) as PageObject).props as { errors: Record<string, string[]>; old: Record<string, unknown>; _conflict: unknown };
  return { errors, old, _conflict };
};
const bound = (document: string, id: string) => ({ ...VISIT, [DOCUMENT_HEADER]: document, [SUBMIT_HEADER]: id });
const NONE = { errors: {}, old: {}, _conflict: null };
const REFUSED = { errors: { title: ['Required.'] }, old: { title: '' }, _conflict: null };

describe('a form that fails validation', () => {
  it('keeps its errors and input for the page of its own submit: a prefetch in between does not take them', async () => {
    const send = await boot();
    expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
    // The prefetch is a normal GET that saves the session: it ages the plain flash data — and shows none of what the record keeps.
    expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', purpose: 'prefetch' } }))).toEqual(NONE);
    const followed = await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }));
    expect(followed.errors.title).toEqual(['Required.']);
    expect(followed.old.title).toBe('');
    expect(followed.old).not.toHaveProperty('password');
    // Taken once.
    expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }))).toEqual(NONE);
  });

  it('is not taken by another tab or a full load in between; the follow-up of the submit takes it, the page after that has none', async () => {
    const send = await boot();
    expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
    for (const headers of [{ ...PAGE, [DOCUMENT_HEADER]: 'tab-b' }, PAGE]) expect(await props(await send('/notes/page', { headers })), JSON.stringify(headers)).toEqual(NONE);
    expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }))).toEqual(REFUSED);
    expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }))).toEqual(NONE);
  });

  it('waits through a poll or a partial reload of the same document that carries no submit id', async () => {
    const send = await boot();
    expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
    const partial = { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [PARTIAL_COMPONENT_HEADER]: 'notes/Edit', [PARTIAL_DATA_HEADER]: 'old,errors' };
    for (const headers of [{ ...PAGE, [DOCUMENT_HEADER]: 'tab-a' }, partial, { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's2' }]) {
      expect(await props(await send('/notes/page', { headers })), JSON.stringify(headers)).toEqual(NONE);
    }
    expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }))).toEqual(REFUSED);
  });

  it('works without JavaScript: the next full page load takes errors and input, a browser prefetch in between does not', async () => {
    const send = await boot();
    expect((await send('/notes/1', submit(NO_SCRIPT))).status).toBe(303);
    expect(await props(await send('/notes/page', { headers: { ...PAGE, 'sec-purpose': 'prefetch' } }))).toEqual(NONE);
    expect(await props(await send('/notes/page', { headers: PAGE }))).toEqual(REFUSED);
  });

  it('releases the binding when the follow-up is answered with the asset-version 409: the full load takes the errors', async () => {
    const send = await boot(undefined, 'v2');
    const own = { [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' };
    expect((await send('/notes/1', submit({ ...VISIT, ...own, [VERSION_HEADER]: 'v2' }))).status).toBe(303);
    expect((await send('/notes/page', { headers: { ...PAGE, [VERSION_HEADER]: 'v1', ...own } })).status).toBe(409);
    expect(await props(await send('/notes/page', { headers: PAGE }))).toEqual(REFUSED);
  });

  it('is ended by a later submit of the same document that succeeds — another document’s record stays', async () => {
    const send = await boot();
    const followUp = (document: string, id: string) => send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: document, [SUBMIT_HEADER]: id } });
    expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
    expect((await send('/notes/1', submit(bound('tab-b', 's3')))).status).toBe(303);
    const ok = await send('/notes/ok', { ...submit({}), headers: { ...bound('tab-a', 's2'), accept: 'application/json' } });
    expect(ok.status).toBe(200);
    expect((await props(await followUp('tab-a', 's1'))).errors, 'the next submit ended it').toEqual({});
    expect(await props(await followUp('tab-b', 's3'))).toEqual(REFUSED);
  });

  it('makes a prefetch wait for a record, bound to a submit or not', async () => {
    const send = await boot();
    const prefetch = () => send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', purpose: 'prefetch' } });
    expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
    expect((await prefetch()).headers.get(FLASH_WAITING_HEADER)).toBe('true');
    expect((await send('/notes/1', submit({ ...VISIT, [DOCUMENT_HEADER]: 'tab-a' }))).status).toBe(303);
    expect((await prefetch()).headers.get(FLASH_WAITING_HEADER)).toBe('true');
  });

  it('still flashes errors and input as plain session data, and shows the errors a controller flashes itself', async () => {
    const memory = new MemorySessionStore();
    const written: string[] = [];
    const send = await boot(wrapped(memory, { write: (key, data, options) => (written.push(data), memory.write(key, data, options)) }));
    expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/"errors":\{"title":\["Required\."\]\}/);
    expect(written[0]).toContain('"_old_input":{"title":""}');
    expect(written[0]).not.toContain('"password"');
    // Never among the flash messages: a release that hands those out would send the record to the browser.
    const payload = JSON.parse(written[0]!) as Record<string, unknown>;
    expect(payload._flash_messages).toBeUndefined();
    expect(payload._sent_back).toHaveLength(1);
    const own = await send('/notes/own', submit(NO_SCRIPT));
    expect(own.status).toBe(303);
    expect((await props(await send('/notes/page', { headers: PAGE }))).errors).toEqual({ title: ['Own.'] });
  });

  it('shows no errors and throws nothing for a record whose errors are not a record of string lists', async () => {
    const memory = new MemorySessionStore();
    // Only the record is damaged (it is written after the plain keys): a string where the list belongs.
    const damaged = (data: string) => data.slice(0, data.indexOf('"_sent_back"')) + data.slice(data.indexOf('"_sent_back"')).replace('{"title":["Required."]}', '{"title":"broken"}');
    const send = await boot(wrapped(memory, { write: (key, data, options) => memory.write(key, damaged(data), options) }));
    expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
    const page = await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } });
    expect(page.status).toBe(200);
    // The plain copy is the record's mirror: it is not shown instead.
    expect(await props(page)).toEqual({ ...REFUSED, errors: {} });
  });

  it.each([
    ['errors-then-input', { errors: { title: ['Own.'] }, old: { title: 'typed' } }],
    ['input-then-errors', { errors: { title: ['Required.'] }, old: { title: 'typed' } }],
    ['string-message', { errors: { title: ['Taken.'] }, old: { title: 'typed' } }],
    // Not a record: it is no errors of the record — the plain flash data is what the page shows, and that is not a record either.
    ['not-a-record', { errors: {}, old: { title: 'typed' } }],
  ])('keeps what a controller flashed by hand (%s) for the page of the submit, whichever way it flashed it', async (how, expected) => {
    const send = await boot();
    expect((await send(`/notes/by-hand?how=${how}`, submit(bound('tab-a', 's1')))).status).toBe(303);
    // In between: a poll of another tab and a prefetch.
    await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-b' } });
    await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', purpose: 'prefetch' } });
    expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }))).toEqual({ ...expected, _conflict: null });
  });

  it('shows the input a page flashed itself, not the record it took', async () => {
    const send = await boot();
    expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
    const page = await props(await send('/notes/fresh', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }));
    expect(page.old).toEqual({ fresh: 'x' });
    expect(page.errors).toEqual({ title: ['Required.'] });
  });

  describe('plain flash data that no record mirrors', () => {
    const follow = (send: Awaited<ReturnType<typeof boot>>, document: string, id: string) => send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: document, [SUBMIT_HEADER]: id } });

    it('shows a controller’s own errors and input while another tab’s record waits', async () => {
      const send = await boot();
      expect((await send('/notes/1', submit(bound('tab-b', 's9')))).status).toBe(303);
      expect((await send('/notes/plain', submit(bound('tab-a', 's1')))).status).toBe(303);
      expect(await props(await follow(send, 'tab-a', 's1'))).toEqual({ errors: { title: ['Own.'] }, old: { title: 'own input' }, _conflict: null });
      expect(await props(await follow(send, 'tab-b', 's9'))).toEqual(REFUSED);
    });

    it('shows them while a conflict-only record waits', async () => {
      const send = await boot();
      expect((await send('/notes/stale', submit(bound('tab-b', 's9')))).status).toBe(303);
      expect((await send('/notes/plain', submit(bound('tab-a', 's1')))).status).toBe(303);
      expect(await props(await follow(send, 'tab-a', 's1'))).toMatchObject({ errors: { title: ['Own.'] }, old: { title: 'own input' }, _conflict: null });
    });

    it('shows what the page flashed itself — and `{}` when that is no record of errors', async () => {
      const send = await boot();
      expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
      expect(await props(await send('/notes/keep?broken', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }))).toEqual({ errors: {}, old: { title: '' }, _conflict: null });
    });

    it('stays hidden from other tabs when a page keeps the copies: the keep carries their mark along', async () => {
      const send = await boot();
      expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
      expect(await props(await send('/notes/keep', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-b' } }))).toEqual(NONE);
      expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-b' } }))).toEqual(NONE);
    });

    it('is not hidden by a `keep()` of keys that hold nothing: the record of the submit still shows', async () => {
      const send = await boot();
      expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
      expect(await props(await send('/notes/keep', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }))).toEqual(REFUSED);
    });
  });

  it('shows nothing of a record that expired to another tab: its plain copies stay hidden', async () => {
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      const send = await boot();
      expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
      vi.advanceTimersByTime(6 * 60_000);
      expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-b' } }))).toEqual(NONE);
      // Its own page finds nothing either: the record ended, and its copies stay hidden.
      expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }))).toEqual(NONE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show the errors and input of a record a later successful submit dropped, on the page that submit answers with', async () => {
    const send = await boot();
    expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
    const saved = await send('/notes/saved', { method: 'POST', headers: bound('tab-a', 's2'), body: new URLSearchParams({ title: 'ok' }) });
    expect(await props(saved)).toEqual(NONE);
    // The record of s1 is gone, not only hidden from this page.
    expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }))).toEqual(NONE);
  });

  describe('a record whose page never comes', () => {
    afterEach(() => vi.useRealTimers());

    it('is gone after five minutes: the page shows nothing, the session stores nothing of it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const memory = new MemorySessionStore();
      const written: string[] = [];
      const send = await boot(wrapped(memory, { write: (key, data, options) => (written.push(data), memory.write(key, data, options)) }));
      expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
      vi.advanceTimersByTime(4 * 60_000);
      expect((await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-b' } })).status).toBe(200);
      expect(written.at(-1)).toContain('_sent_back');
      vi.advanceTimersByTime(2 * 60_000);
      expect(await props(await send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', [SUBMIT_HEADER]: 's1' } }))).toEqual(NONE);
      expect(written.at(-1)).not.toContain('_sent_back');
    });

    it('does not make a prefetch wait once it is gone', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const send = await boot();
      expect((await send('/notes/1', submit(bound('tab-a', 's1')))).status).toBe(303);
      const prefetch = () => send('/notes/page', { headers: { ...PAGE, [DOCUMENT_HEADER]: 'tab-a', purpose: 'prefetch' } });
      expect((await prefetch()).headers.get(FLASH_WAITING_HEADER)).toBe('true');
      vi.advanceTimersByTime(6 * 60_000);
      expect((await prefetch()).headers.get(FLASH_WAITING_HEADER)).toBeNull();
    });
  });
});
