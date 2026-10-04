import { describe, expect, it, vi } from 'vitest';
import type { ValidationErrors } from '../../page.ts';
import { guard } from './guard.ts';
import { hooks, type BeforeVisit, type ClientHooks, type InvalidAnswer } from './hooks.ts';
import { prefetch } from './prefetch.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse, settle } from '../test-window.ts';

/** The client hook API (E132): `before` cancels a visit before its request goes out, `invalid` reports a form sent back. */

function tab(url = '/a') {
  const win = new FakeWindow(`${ORIGIN}${url}`);
  win.handler = (to, init) => {
    const { pathname } = new URL(to);
    // A form sent back with its errors (the server redirected back): the same page, its `errors` prop filled.
    if (pathname === '/register' && init.method === 'POST') return pageResponse(page('/register', { errors: { email: ['The email is taken.'] } }, 'auth/Register'));
    return pageResponse(page(pathname, { errors: {} }, 'pages/Other'));
  };
  return { win, ...boot(win, page(url, {}, 'pages/A')) };
}

describe('the hook API (E132) — a feature: navigator.use(hooks)', () => {
  it('before: every visit of the navigator, with what it asked for — before its request', async () => {
    const { win, navigator } = tab();
    const seen: { url: string; method: string; only: readonly string[] | undefined; layer: boolean; requests: number }[] = [];
    navigator.use(hooks).on('before', (event) => void seen.push({ url: event.url, method: event.method, only: event.options.only, layer: event.layer, requests: win.requests.length }));
    await navigator.visit('/users/2');
    await navigator.reload({ only: ['stats'] });
    await navigator.visit('/users/2/edit', { layer: true });
    expect(seen).toEqual([
      { url: `${ORIGIN}/users/2`, method: 'get', only: undefined, layer: false, requests: 0 },
      { url: `${ORIGIN}/users/2`, method: 'get', only: ['stats'], layer: false, requests: 1 },
      { url: `${ORIGIN}/users/2/edit`, method: 'get', only: undefined, layer: true, requests: 2 },
    ]);
  });

  it('before: cancel() stops the visit — no request goes out, no visit event fires, the visit ends undefined', async () => {
    const { win, navigator } = tab();
    const events = vi.fn();
    for (const name of ['start', 'finish', 'cancel'] as const) navigator.on(name, events);
    const stop = navigator.use(hooks).on('before', (event) => {
      if (event.url.endsWith('/admin')) event.cancel();
    });
    expect(await navigator.visit('/admin')).toBeUndefined();
    expect(win.requests).toEqual([]); // the network counter: nothing was sent
    expect(events).not.toHaveBeenCalled();
    expect(navigator.page.url).toBe('/a');
    // Others go on — and a listener that stopped listening cancels nothing.
    await navigator.visit('/users/2');
    expect(win.requests.map((request) => new URL(request.url).pathname)).toEqual(['/users/2']);
    stop();
    await navigator.visit('/admin');
    expect(win.requests.at(-1)?.url).toBe(`${ORIGIN}/admin`);
  });

  it('before: every listener is told — the later ones see that it is cancelled', async () => {
    const { navigator } = tab();
    const api = navigator.use(hooks);
    const later = vi.fn((event: BeforeVisit) => event.cancelled);
    api.on('before', (event) => event.cancel());
    api.on('before', later);
    await navigator.visit('/users/2');
    expect(later).toHaveReturnedWith(true);
  });

  it('before runs ahead of the guard: a visit the app stops asks nothing about unsaved changes', async () => {
    const { win, navigator } = tab();
    navigator.use(guard).add({ message: 'Unsaved changes' });
    navigator.use(hooks).on('before', (event) => event.cancel());
    await navigator.visit('/users/2');
    expect(win.asked).toEqual([]);
    expect(win.requests).toEqual([]);
  });

  it('before is for visits only — not for Back/Forward to a page memory let go of, deferred props or prefetches', async () => {
    const { win, navigator } = tab();
    const before = vi.fn();
    navigator.use(hooks).on('before', before);
    await navigator.use(prefetch).prefetch('/users/3');
    win.handler = (to) => pageResponse({ ...page(new URL(to).pathname, {}, 'pages/Other'), deferredProps: { default: ['later'] } });
    await navigator.reload({ async: true, only: ['x'] });
    await settle();
    expect(before).toHaveBeenCalledOnce(); // the reload — not the prefetch, not its deferred props
    expect(win.requests.length).toBeGreaterThan(2);
  });

  it('invalid: a visit that came back with validation errors — typed errors, where it went, the route name', async () => {
    const { navigator } = tab('/register');
    const invalid = vi.fn<(event: InvalidAnswer) => void>();
    navigator.use(hooks).on('invalid', invalid);
    await navigator.visit('/register', { method: 'post', data: { email: 'ada@example.com' }, name: 'register.store' });
    await navigator.visit('/users/2');
    expect(invalid).toHaveBeenCalledOnce();
    expect(invalid.mock.calls[0]![0]).toEqual({ errors: { email: ['The email is taken.'] }, url: '/register', method: 'post', name: 'register.store' });
  });

});

// Type guarantees (E132): the events and their payloads are typed — read the real messages by removing a directive.
function typed(api: ClientHooks, navigator: ReturnType<typeof tab>['navigator']): void {
  // @ts-expect-error — `before` is the hook API's (navigator.use(hooks).on), not one of the core's events
  navigator.on('before', () => {});
  // @ts-expect-error — no such event: `before` and `invalid` only
  api.on('beforeVisit', () => {});
  api.on('before', (event) => {
    event.cancel();
    // @ts-expect-error — `before` has no errors: they come with `invalid`
    void event.errors;
    // @ts-expect-error — what the visit asked for is read-only: `before` cancels, it does not change a visit
    event.options.only = ['x'];
  });
  api.on('invalid', (event) => {
    const errors: ValidationErrors = event.errors;
    void errors;
    // @ts-expect-error — an answer that came back cannot be cancelled
    event.cancel();
  });
  // @ts-expect-error — a `before` listener gets a BeforeVisit, not an InvalidAnswer
  api.on('before', (event: InvalidAnswer) => void event);
  const off: () => void = api.on('invalid', () => {});
  off();
}
void typed;
