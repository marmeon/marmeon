import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlashMessage } from '../page.ts';
import { ACTION_HEADER, ACTION_REDIRECT_HEADER, FLASH_HEADER, FLASH_WAITING_HEADER, LAYER_CLOSE_HEADER, LOCATION_HEADER, PAGE_HEADER, REGION_HEADER, type PageObject, PROTOCOL_VERSION } from '../protocol.ts';
import type { ConfirmRequest } from './confirm.ts';
import { dirtyPaths, isDirtyPath } from './forms.ts';
import { isCurrentLink } from './links.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse, PATHS, settle, withActions } from './test-window.ts';
import { prefetch } from './features/prefetch.ts';
import { guard } from './features/guard.ts';

/** Flash, state attributes, the navigation guard and confirm in the client core. */

const toast = (id: string, message = 'Saved.'): FlashMessage => ({ id, key: 'toast', data: { kind: 'success', message } }) as unknown as FlashMessage;
const withFlash = (body: PageObject, ...flash: FlashMessage[]): PageObject => ({ ...body, flash });

/** A tab whose navigator records every flash message it fires. */
function tab(initial: PageObject, url = `${ORIGIN}${initial.url}`, options: Parameters<typeof boot>[2] = {}) {
  const win = new FakeWindow(url);
  const fired: string[] = [];
  const booted = boot(win, initial, options);
  booted.navigator.on('flash', (message) => fired.push(`${message.id} ${(message.data as { message: string }).message}`));
  return { win, fired, ...booted };
}

describe('flash messages in the core', () => {
  it('fires the first page’s messages once the app listens — never keeps them with the page', async () => {
    const { fired, navigator } = tab(withFlash(page('/users/1'), toast('a')));
    expect(fired).toEqual(['a Saved.']);
    expect(navigator.page.flash).toBeUndefined();
  });

  it('fires a visit’s messages after its page is on screen — and Back/Forward from memory fires nothing again', async () => {
    const { win, fired, navigator, visible } = tab(page('/users/1/edit'));
    win.handler = () => pageResponse(withFlash(page('/users/1'), toast('saved')));
    await navigator.visit('/users/1/edit', { method: 'put', data: {} });
    expect(fired).toEqual(['saved Saved.']);
    expect(visible().flash).toBeUndefined();
    win.handler = () => pageResponse(page('/people'));
    await navigator.visit('/people');
    win.back();
    await settle();
    win.forward();
    await settle();
    expect(fired).toEqual(['saved Saved.']);
  });

  it('the same message delivered twice (a race of two requests) fires once — by its id', async () => {
    const { win, fired, navigator } = tab(page('/users/1'));
    win.handler = () => pageResponse(withFlash(page('/users/1'), toast('same')));
    await navigator.reload({ only: ['activity'] });
    await navigator.reload({ only: ['activity'] });
    expect(fired).toEqual(['same Saved.']);
  });

  it('two saves with the same message fire twice (two ids) — no "only when it changed"', async () => {
    const { win, fired, navigator } = tab(page('/users/1'));
    let id = 0;
    win.handler = () => pageResponse(withFlash(page('/users/1'), toast(`save-${++id}`)));
    await navigator.visit('/users/1', { method: 'put', data: {} });
    await navigator.visit('/users/1', { method: 'put', data: {} });
    expect(fired).toEqual(['save-1 Saved.', 'save-2 Saved.']);
  });

  it('fires what a partial reload, an action and a layer’s close deliver — wherever on screen it lands', async () => {
    const { win, fired, navigator } = tab(page('/users/1'));
    win.handler = (url, init) => {
      const headers = init.headers as Record<string, string>;
      if (headers[ACTION_HEADER]) return new Response(null, { status: 204, headers: { [ACTION_REDIRECT_HEADER]: '/users/1', [FLASH_HEADER]: encodeURIComponent(JSON.stringify([toast('action', 'Link removed.')])) } });
      if (headers[REGION_HEADER] === 'layer' && init.method === 'PUT') {
        return new Response(JSON.stringify({ close: { layers: 1 }, flash: [toast('close', 'Profile saved.')] }), { headers: { 'content-type': 'application/json', [LAYER_CLOSE_HEADER]: 'true' } });
      }
      if (headers[REGION_HEADER] === 'layer') return pageResponse({ ...page('/users/1/edit', {}, 'user-profile/Edit'), layer: { key: 'edit', base: '/users/1' } });
      return pageResponse(withFlash(page('/users/1'), toast(`reload-${url.length}`, 'Reloaded.')));
    };
    const outcome = await withActions(navigator).action('/users/1/links/2', { method: 'delete' });
    expect(outcome).toMatchObject({ kind: 'redirect', flash: [{ id: 'action' }] });
    await navigator.visit('/users/1/edit', { layer: true });
    await navigator.layers[0]!.visit('/users/1', { method: 'put', data: {} });
    expect(fired).toEqual(['action Link removed.', 'close Profile saved.']);
  });

  it('a prefetch that says messages wait is not shown — the click asks, and its answer brings them (the toast is not lost)', async () => {
    const { win, fired, navigator, visible } = tab(page('/users/1'));
    let asked = 0;
    win.handler = (_url, init) => {
      const prefetch = (init.headers as Record<string, string>).purpose === 'prefetch';
      if (prefetch) return new Response(JSON.stringify(page('/people', { people: 'prefetched' })), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, 'content-type': 'application/json', [FLASH_WAITING_HEADER]: 'true' } });
      asked++;
      return pageResponse(withFlash(page('/people', { people: 'fresh' }), toast('waiting', 'From the other tab.')));
    };
    await navigator.use(prefetch).prefetch('/people');
    await navigator.visit('/people');
    expect(asked).toBe(1);
    expect(visible().props).toEqual({ people: 'fresh' });
    expect(fired).toEqual(['waiting From the other tab.']);
  });

  it('a listener added later gets what nobody heard yet — once; one key at a time', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const { navigator } = boot(win, withFlash(page('/users/1'), toast('early'), { id: 'n', key: 'notice', data: 'x' } as unknown as FlashMessage));
    const toasts: string[] = [];
    const notices: string[] = [];
    navigator.onFlash('toast', (message) => toasts.push(message.id));
    navigator.onFlash('toast', (message) => toasts.push(`second ${message.id}`));
    navigator.onFlash('notice' as never, (message) => notices.push(message.id));
    expect(toasts).toEqual(['early']);
    expect(notices).toEqual(['n']);
  });
});

describe('state attributes in the core', () => {
  it('knows the visit under way — by URL, method and route name — and lists nothing in the background', async () => {
    const { win, navigator } = tab(page('/users/1'));
    let open!: (response: Response) => void;
    win.handler = () => new Promise((resolve) => (open = resolve));
    const seen: (string | undefined)[] = [];
    navigator.subscribeVisiting(() => seen.push(navigator.visiting?.url));
    const visiting = navigator.visit('/people', { name: 'user-profile.people' });
    expect(navigator.visiting).toMatchObject({ url: '/people', method: 'get', name: 'user-profile.people' });
    expect(navigator.isPending('user-profile.people')).toBe(true);
    open(pageResponse(page('/people')));
    await visiting;
    expect(navigator.visiting).toBeUndefined();
    expect(seen).toEqual(['/people', undefined]);
    void navigator.reload({ async: true, only: ['x'] });
    expect(navigator.visiting).toBeUndefined();
  });

  it('an action of a route is pending too — what the actions feature has under way — and who follows `visiting` hears it', async () => {
    const { win, navigator } = tab(page('/users/1'));
    let open!: (response: Response) => void;
    win.handler = () => new Promise((resolve) => (open = resolve));
    expect(navigator.isPending('links.destroy')).toBe(false); // no feature has anything under way
    const { action } = withActions(navigator);
    let heard = 0;
    navigator.subscribeVisiting(() => heard++);
    const removing = action('/users/1/links/1', { method: 'delete', name: 'links.destroy' });
    expect(navigator.isPending('links.destroy')).toBe(true);
    expect(navigator.visiting).toBeUndefined(); // an action is no visit
    expect(heard).toBe(1);
    open(new Response(null, { status: 204 }));
    await removing;
    expect(navigator.isPending('links.destroy')).toBe(false);
    expect(heard).toBe(2);
  });

  it('a link is current for the same URL — or for the routes `activeMatch` names', () => {
    const people = { url: '/people?sort=-name&q=a', route: 'user-profile.people' };
    expect(isCurrentLink(people, '/people?q=a&sort=-name')).toBe(true);
    expect(isCurrentLink(people, '/people?q=a')).toBe(false); // another order
    expect(isCurrentLink(people, '/people')).toBe(false);
    expect(isCurrentLink(people, '/people', 'user-profile.people')).toBe(true);
    expect(isCurrentLink(people, '/users/me', 'user-profile.*')).toBe(true);
    expect(isCurrentLink(people, '/users/me', ['auth.*', 'dashboard.show'])).toBe(false);
    expect(isCurrentLink({ url: '/users/1' }, '/users/1#links')).toBe(true);
  });

  it('dirty paths: the leaves that differ, typed paths in and out', () => {
    const initial = { name: 'Ada', bio: '', links: [{ url: 'a' }], tags: ['x'] };
    const dirty = dirtyPaths(initial, { name: 'Ada', bio: 'Math.', links: [{ url: 'b' }], tags: ['x', 'y'] });
    expect(dirty).toEqual(['bio', 'links.0.url', 'tags', 'tags.1']);
    expect(isDirtyPath(dirty, 'links')).toBe(true);
    expect(isDirtyPath(dirty, 'name')).toBe(false);
    expect(isDirtyPath(dirtyPaths(initial, structuredClone(initial)))).toBe(false);
  });
});

describe.each(PATHS)('the guard on the %s path', (path) => {
  beforeEach(() => void (FakeWindow.path = path));
  afterEach(() => void (FakeWindow.path = 'navigation'));

  describe('the navigation guard', () => {
    const asking = (answers: boolean[]) => {
      const asked: ConfirmRequest[] = [];
      return { asked, confirm: (request: ConfirmRequest) => (asked.push(request), answers.shift() ?? false) };
    };

    it('blocks a visit while dirty — Stay sends nothing, Leave goes; after saving it lets the visit through', async () => {
      const { asked, confirm } = asking([false, true]);
      const { win, navigator, visible } = tab(page('/users/1/edit'), undefined, { confirm });
      win.handler = (url) => pageResponse(page(new URL(url).pathname));
      let dirty = true;
      navigator.use(guard).add({ message: 'Unsaved changes.', active: () => dirty });
      expect(await navigator.visit('/people')).toBeUndefined();
      expect(win.requests).toEqual([]);
      expect(asked).toEqual([{ kind: 'leave', message: 'Unsaved changes.' }]);
      await navigator.visit('/people');
      expect(visible().url).toBe('/people');
      win.handler = () => pageResponse(page('/users/1/edit'));
      await navigator.visit('/users/1/edit', { ignoreGuards: true });
      dirty = false; // saved
      await navigator.visit('/dashboard');
      expect(asked).toHaveLength(2);
    });

    it('a form’s own submit passes its guard — a partial reload, a poll, a reload of the page ask nothing', async () => {
      const { asked, confirm } = asking([]);
      const { win, navigator } = tab(page('/users/1/edit'), undefined, { confirm });
      win.handler = () => pageResponse(page('/users/1/edit'));
      const own = { message: 'Unsaved.' };
      navigator.use(guard).add(own);
      await navigator.visit('/users/1/edit', { method: 'put', data: {}, ignoreGuards: [own] });
      await navigator.reload({ only: ['profile'] });
      await navigator.reload();
      await navigator.visit('/users/1/edit', { async: true, only: ['x'] });
      expect(asked).toEqual([]);
      expect(win.requests).toHaveLength(4);
    });

    it('Back while dirty — the core goes forward again, asks, and Leave does the Back after all', async () => {
      const { asked, confirm } = asking([false, true]);
      const { win, navigator, visible } = tab(page('/users/1'), undefined, { confirm });
      win.handler = () => pageResponse(page('/users/1/edit', {}, 'user-profile/Edit'));
      await navigator.visit('/users/1/edit');
      const stop = navigator.use(guard).add({ message: 'Unsaved.' });
      win.back();
      await settle();
      await settle();
      // Stay: back where it was — in the history too.
      expect(asked, 'Back was not asked about').toHaveLength(1);
      expect(win.current.url).toBe(`${ORIGIN}/users/1/edit`);
      expect(visible().url).toBe('/users/1/edit');
      win.back();
      await settle();
      await settle();
      await settle();
      expect(asked).toHaveLength(2);
      expect(win.current.url).toBe(`${ORIGIN}/users/1`);
      expect(visible().url).toBe('/users/1');
      stop();
    });

    it('a guard in a layer asks when the layer closes (Escape, Back) — not when a link elsewhere on the page opens another layer over it', async () => {
      const { asked, confirm } = asking([false]);
      const { win, navigator } = tab(page('/users/1'), undefined, { confirm });
      win.handler = (url) => pageResponse({ ...page(new URL(url).pathname, {}, 'user-profile/Edit'), layer: { key: new URL(url).pathname, base: '/users/1' } });
      await navigator.visit('/users/1/edit', { layer: true });
      const layer = navigator.layers[0]!;
      navigator.use(guard).add({ message: 'Unsaved.', layer });
      await layer.close();
      expect(asked).toHaveLength(1);
      expect(navigator.layers).toHaveLength(1);
      // Stay — and it can still be closed afterwards (no stuck "closing").
      await navigator.layers[0]!.visit('/users/1/links/1/remove', { layer: true });
      expect(navigator.layers).toHaveLength(2);
      expect(asked).toHaveLength(1);
    });

    it('closing the tab or reloading while dirty gets the browser’s question — never after a 409 (signed out, a new build): the server wins', async () => {
      const { asked, confirm } = asking([]);
      const { win, navigator } = tab(page('/users/1/edit'), undefined, { confirm });
      expect(win.unload()).toBe(false);
      navigator.use(guard).add({ message: 'Unsaved.' });
      expect(win.unload()).toBe(true);
      // Signed out in another tab: the next request is a 409 — the document goes, unasked, and leaving is not stopped.
      win.handler = () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login' } });
      await navigator.reload({ only: ['profile'] });
      expect(win.loads).toEqual(['replace https://app.test/login']);
      expect(asked).toEqual([]);
      expect(win.unload()).toBe(false);
    });
  });
});

describe('confirm', () => {
  it('a no sends nothing — a visit, an action', async () => {
    const { win, navigator } = tab(page('/users/1'));
    win.handler = () => pageResponse(page('/users/1'));
    win.confirmAnswer = false;
    expect(await navigator.visit('/users/1/links/1', { method: 'delete', confirm: 'Remove this link?' })).toBeUndefined();
    expect(await withActions(navigator).action('/users/1/links/1', { method: 'delete', confirm: { message: 'Remove?' } })).toEqual({ ok: false, kind: 'cancelled' });
    expect(win.requests).toEqual([]);
    expect(win.asked).toEqual(['confirm Remove this link?', 'confirm Remove?']);
    win.confirmAnswer = true;
    await withActions(navigator).action('/users/1/links/1', { method: 'delete', confirm: 'Remove?' });
    expect(win.requests).toHaveLength(1);
  });

  it('type-to-confirm takes only the exact text — a wrong one (or a bare yes) sends nothing', async () => {
    const answers: (string | boolean)[] = ['DELET', true, 'delete', 'DELETE'];
    const { win, navigator } = tab(page('/projects/1'), undefined, { confirm: () => answers.shift()! });
    win.handler = () => pageResponse(page('/projects'));
    const remove = () => withActions(navigator).action('/projects/1', { method: 'delete', confirm: { message: 'Delete the project?', prompt: 'DELETE' } });
    for (let attempt = 0; attempt < 3; attempt++) expect(await remove()).toEqual({ ok: false, kind: 'cancelled' });
    expect(win.requests).toEqual([]);
    await remove();
    expect(win.requests).toHaveLength(1);
  });

  it('the browser’s own dialogs by default: confirm(), and prompt() to type the text', async () => {
    const { win, navigator } = tab(page('/projects/1'));
    win.promptAnswer = 'DELETE';
    expect(await navigator.confirm({ title: 'Delete it?', message: 'This cannot be undone.', prompt: 'DELETE' })).toBe(true);
    expect(win.asked).toEqual(['prompt Delete it?\n\nThis cannot be undone.']);
  });
});
