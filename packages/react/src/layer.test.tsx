// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1" }
import { LAYER_CLOSE_HEADER, PAGE_HEADER, REGION_HEADER, type PageObject, type RouteManifest } from '@marmeon/http/page';
import { Suspense, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, loadLayerStack, usePage, useRouter } from './app.tsx';
import { Head } from './head.tsx';
import { Island } from './island.tsx';
import { LayerDialog } from './layer-dialog.tsx';
import { useLayer, type LayerState } from './layer.tsx';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { loadView } from './views.ts';
import { loadHistoryFallback } from '@marmeon/http/client';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Profile({ name }: { name: string }) {
  return (
    <main>
      <h1 data-testid="name">{name}</h1>
      <Island route="sign-ins" fallback={<p>Loading…</p>} />
      <Link route="edit" layer data-testid="edit">
        Edit
      </Link>
    </main>
  );
}

function Edit({ name, errors = {} }: { name: string; errors?: Record<string, string> }) {
  const layer = useLayer();
  const page = usePage<{ name: string }>();
  const router = useRouter();
  const { visit } = router;
  return (
    <section>
      <Head title="Edit profile" />
      <h2>Edit {page.props.name}</h2>
      <input data-testid="field" autoFocus defaultValue={name} />
      {errors.name && <p data-testid="error">{errors.name}</p>}
      <span data-testid="depth">{layer.depth}</span>
      <button type="button" data-testid="save" onClick={() => void visit('/users/1', { method: 'put', data: { name: 'A' } })}>
        Save
      </button>
      <button
        type="button"
        data-testid="save-optimistic"
        onClick={() => void visit('/users/1', { method: 'put', data: { name: 'B' }, optimistic: router.optimistic(() => ({ name: 'Saving…' })) })}
      >
        Save at once
      </button>
      <button type="button" data-testid="close" onClick={() => void layer.close()}>
        Cancel
      </button>
      <Link route="rename" layer data-testid="rename">
        Rename
      </Link>
      <Link route="confirm" layer data-testid="confirm">
        Remove
      </Link>
    </section>
  );
}

function Confirm() {
  const layer = useLayer();
  return (
    <section>
      <h2>Sure?</h2>
      <span data-testid="confirm-depth">{layer.depth}</span>
      <button type="button" data-testid="destroy">
        Remove
      </button>
      <button type="button" data-testid="keep" autoFocus onClick={() => void layer.close()}>
        Keep it
      </button>
    </section>
  );
}
Confirm.layer = 'slideover' as const;

function Rename() {
  return (
    <section>
      <h2>Rename</h2>
      <button type="button" data-testid="delete">
        Delete
      </button>
      <input data-testid="rename-field" autoFocus />
    </section>
  );
}

function Done() {
  return (
    <section>
      <h2>Done</h2>
    </section>
  );
}

function SignIns() {
  return <p data-testid="sign-ins">signed in</p>;
}

function AsPage() {
  const layer = useLayer();
  return <p data-testid="as-page">{String(layer.isLayer)}</p>;
}

const pages: Record<string, PageComponent> = { Profile, Edit, Confirm, Rename, SignIns, AsPage, Done };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const routes: RouteManifest = {
  edit: { method: 'get', path: '/users/1/edit' },
  confirm: { method: 'get', path: '/users/1/confirm' },
  rename: { method: 'get', path: '/users/1/rename' },
  'sign-ins': { method: 'get', path: '/islands/sign-ins' },
};
const page = (name: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null });
const layer = (name: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ ...page(name, url, props), layer: { key: `app/${name}`, base: '/users/1' } });
const respond = (body: object, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: 'true', ...headers } });

let server: (url: string, init: RequestInit) => Response | Promise<Response>;
let requests: { url: string; method: string; headers: Record<string, string> }[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/users/1');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  document.documentElement.style.overflow = '';
  document.body.removeAttribute('style');
  requests = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    requests.push({ url: String(input).replace(window.location.origin, ''), method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) } });
    return server(String(input).replace(window.location.origin, ''), init);
  });
  server = (url, init) => {
    const { pathname } = new URL(url, location.href);
    if (pathname === '/islands/sign-ins') return respond(page('SignIns', pathname), { [REGION_HEADER]: 'island' });
    if (pathname === '/users/1/edit') return respond(layer('Edit', pathname, { name: 'Ada' }));
    if (pathname === '/users/1/rename') return respond(layer('Rename', pathname));
    if (pathname === '/users/1/confirm') return respond(layer('Confirm', pathname));
    if (pathname === '/users/1' && init.method === 'PUT') return respond(layer('Edit', '/users/1/edit', { name: 'Ada', errors: { name: 'Too short.' } }));
    return new Response('not found', { status: 404 });
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

async function mount(initial: PageObject) {
  const Component = await resolve(initial.component);
  await Promise.all((initial.layers ?? []).map((layered) => loadView(resolve, layered.component)));
  root = createRoot(container);
  await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} />));
}

const $ = (selector: string) => container.querySelector(selector);
const wait = (ms = 10) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const click = (selector: string) => act(async () => ($(selector) as HTMLElement).click());
const dialogs = () => [...container.querySelectorAll('dialog[data-marmeon-layer]')];

describe('Layers in React', () => {
  it('<Link layer> opens the view in a modal dialog over the page — the page stays, its island is not loaded again', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    const islands = () => requests.filter((request) => request.headers[REGION_HEADER] === 'island').length;
    expect(islands()).toBe(1);
    const heading = $('[data-testid="name"]');

    await click('[data-testid="edit"]');
    // The first layer of the file: the stack's chunk loads with it — under a busy test run, that may take more than a tick.
    for (let tries = 0; tries < 100 && dialogs().length === 0; tries++) await wait();
    expect(requests.at(-1)).toMatchObject({ url: '/users/1/edit', headers: { [REGION_HEADER]: 'layer' } });
    const [dialog] = dialogs();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    expect(dialog!.getAttribute('data-variant')).toBe('modal');
    // Named by its heading.
    expect(document.getElementById(dialog!.getAttribute('aria-labelledby')!)!.textContent).toBe('Edit Ada');
    // usePage() inside is the layer's page; the page beneath is the same element, not rendered anew.
    expect($('[data-testid="name"]')).toBe(heading);
    expect(location.pathname).toBe('/users/1/edit');
    expect(document.title).toBe('Edit profile');
    expect(document.documentElement.style.overflow).toBe('hidden');

    await act(async () => history.back());
    await wait(30);
    expect(dialogs()).toEqual([]);
    expect(location.pathname).toBe('/users/1');
    expect($('[data-testid="name"]')).toBe(heading);
    expect(document.documentElement.style.overflow).toBe('');
    // Closing does not load the page's island again (its owner stays the page's).
    expect(islands()).toBe(1);
  });

  it('focus goes back to the link that opened the layer when it closes', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    const opener = $('[data-testid="edit"]') as HTMLAnchorElement;
    opener.focus();
    await act(async () => opener.click());
    await wait();
    // The field took the focus as it mounted (autoFocus) — the opener is still what gets it back.
    expect(document.activeElement).toBe($('[data-testid="field"]'));

    await click('[data-testid="close"]');
    await wait(30);
    expect(dialogs()).toEqual([]);
    expect(document.activeElement).toBe(opener);
  });

  it('an autoFocus field in the layer does not scroll the page beneath: the focus lands, the scroll position is put back', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    let scrollY = 600;
    const original = Object.getOwnPropertyDescriptor(window, 'scrollY');
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(((options: ScrollToOptions) => {
      scrollY = options.top ?? scrollY;
    }) as typeof window.scrollTo);
    // A browser scrolls to an element it focuses without `preventScroll` — the dialog is at the end of the document until it is modal.
    const focus = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (!options?.preventScroll) scrollY = 20_000;
      focus.call(this, options);
    });
    try {
      await click('[data-testid="edit"]');
      await wait();
      expect(document.activeElement).toBe($('[data-testid="field"]'));
      expect(scrollY).toBe(600);
      expect(scrollTo).toHaveBeenCalled();
      await click('[data-testid="close"]');
      await wait(30);
      expect(dialogs()).toEqual([]);
    } finally {
      spy.mockRestore();
      scrollTo.mockRestore();
      if (original) Object.defineProperty(window, 'scrollY', original);
      else delete (window as { scrollY?: number }).scrollY;
    }
  });

  it('a modal layer fixes the body at the scroll position (iOS) and restores it when the last layer closes', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    let scrollY = 600;
    const original = Object.getOwnPropertyDescriptor(window, 'scrollY');
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(((options: ScrollToOptions) => {
      scrollY = options.top ?? scrollY;
    }) as typeof window.scrollTo);
    document.body.style.position = 'relative';
    document.body.style.top = '5px';
    try {
      await click('[data-testid="edit"]');
      await wait();
      expect(document.body.style.position).toBe('fixed');
      expect(document.body.style.top).toBe('-600px');
      expect(document.body.style.width).toBe('100%');
      scrollTo.mockClear();
      await click('[data-testid="close"]');
      await wait(30);
      expect(dialogs()).toEqual([]);
      expect(document.body.style.position).toBe('relative');
      expect(document.body.style.top).toBe('5px');
      expect(document.body.style.width).toBe('');
      expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 600, behavior: 'instant' });
      expect(scrollY).toBe(600);
    } finally {
      scrollTo.mockRestore();
      if (original) Object.defineProperty(window, 'scrollY', original);
      else delete (window as { scrollY?: number }).scrollY;
    }
  });

  it('reserves the scrollbar gutter while a layer is open, so the page does not shift, and restores it', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    // A 15px classic scrollbar: the window is wider than the document's client width.
    const original = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => window.innerWidth - 15 });
    try {
      await click('[data-testid="edit"]');
      await wait();
      expect(document.documentElement.style.scrollbarGutter).toBe('stable');
      await click('[data-testid="close"]');
      await wait(30);
      expect(document.documentElement.style.scrollbarGutter).toBe('');
    } finally {
      if (original) Object.defineProperty(document.documentElement, 'clientWidth', original);
      else delete (document.documentElement as { clientWidth?: number }).clientWidth;
    }
  });

  it('a smooth scroll that autoFocus starts (scrollY has not moved yet) is cancelled when the layer becomes modal', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    let pending: number | null = null;
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(((options: ScrollToOptions) => {
      if (options.behavior === 'instant') pending = null;
    }) as typeof window.scrollTo);
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (!options?.preventScroll) pending = 20_000;
      focus.call(this, options);
    });
    await click('[data-testid="edit"]');
    await wait();
    expect(scrollTo).toHaveBeenCalled();
    expect(pending).toBeNull();
    await click('[data-testid="close"]');
    await wait(30);
  });

  it('a click that does not focus the link (WebKit) still gives the focus back to it when the layer closes', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    const opener = $('[data-testid="edit"]') as HTMLAnchorElement;
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await act(async () => opener.click());
    await wait();
    expect(dialogs()).toHaveLength(1);

    await click('[data-testid="close"]');
    await wait(30);
    expect(dialogs()).toEqual([]);
    expect(document.activeElement).toBe(opener);
  });

  it('a modified click leaves the link alone: no focus, no layer', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    const opener = $('[data-testid="edit"]') as HTMLAnchorElement;
    const before = requests.length;
    await act(async () => void opener.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })));
    await act(async () => void opener.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
    await wait();
    expect(document.activeElement).not.toBe(opener);
    expect(dialogs()).toEqual([]);
    expect(requests.length).toBe(before);
  });

  it('Escape closes the layer (the dialog’s cancel) — closed by the layer, not by the browser', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    await click('[data-testid="edit"]');
    await wait();
    const cancel = new Event('cancel', { cancelable: true });
    await act(async () => void dialogs()[0]!.dispatchEvent(cancel));
    await wait(30);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialogs()).toEqual([]);
  });

  it('a form inside the layer submits as the layer — its errors come back into it, what was typed stays', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    await click('[data-testid="edit"]');
    await wait();
    const field = $('[data-testid="field"]') as HTMLInputElement;
    field.value = 'A';

    await click('[data-testid="save"]');
    await wait();
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', headers: { [REGION_HEADER]: 'layer' } });
    expect($('[data-testid="error"]')!.textContent).toBe('Too short.');
    expect($('[data-testid="field"]')).toBe(field);
    expect(field.value).toBe('A');
    expect(dialogs()).toHaveLength(1);
  });

  it('a form inside the layer shows its optimistic patch while it is sent — the layer’s, gone when the answer lands', async () => {
    let answer!: (response: Response) => void;
    const saving = server;
    server = (url, init) => (init.method === 'PUT' ? new Promise((resolve) => (answer = resolve)) : saving(url, init));
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    await click('[data-testid="edit"]');
    await wait();
    await click('[data-testid="save-optimistic"]');
    await wait();
    // The core applies a visit's patches, whatever is attached: a layer's patch shows, though nothing on the page made one.
    expect(dialogs()[0]!.querySelector('h2')!.textContent).toBe('Edit Saving…');
    await act(async () => answer(respond(layer('Edit', '/users/1/edit', { name: 'Ada', errors: { name: 'Too short.' } }))));
    await wait();
    expect(dialogs()[0]!.querySelector('h2')!.textContent).toBe('Edit Ada');
  });

  it('closeLayer() from the server closes it — and reloads what is beneath', async () => {
    server = (url, init) => {
      const { pathname } = new URL(url, location.href);
      if (pathname === '/islands/sign-ins') return respond(page('SignIns', pathname), { [REGION_HEADER]: 'island' });
      if (pathname === '/users/1/edit') return respond(layer('Edit', pathname, { name: 'Ada' }));
      if (init.method === 'PUT') return new Response(JSON.stringify({ close: { layers: 1, reload: ['name'] } }), { headers: { [LAYER_CLOSE_HEADER]: 'true' } });
      return respond(page('Profile', '/users/1', { name: 'Grace' }));
    };
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    await click('[data-testid="edit"]');
    await wait();
    await click('[data-testid="save"]');
    await wait(40);
    expect(dialogs()).toEqual([]);
    expect($('[data-testid="name"]')!.textContent).toBe('Grace');
    expect(requests.at(-1)).toMatchObject({ url: '/users/1', headers: { 'x-marmeon-partial-data': 'name' } });
  });

  it('stacks to depth 2 — the view’s own look (a slide-over), useLayer().depth', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    await click('[data-testid="edit"]');
    await wait();
    await click('[data-testid="confirm"]');
    await wait();
    expect(dialogs().map((dialog) => [dialog.getAttribute('data-depth'), dialog.getAttribute('data-variant')])).toEqual([
      ['1', 'modal'],
      ['2', 'slideover'],
    ]);
    expect($('[data-testid="confirm-depth"]')!.textContent).toBe('2');
    // The view's choice of focus (autoFocus) holds — not the first button (showModal's default: the destructive one).
    expect(document.activeElement).toBe($('[data-testid="keep"]'));

    await act(async () => history.back());
    await wait(30);
    expect(dialogs()).toHaveLength(1);
    expect($('[data-testid="depth"]')!.textContent).toBe('1');
    // The lock is taken once and held until the last layer closes.
    expect(document.body.style.position).toBe('fixed');
    await act(async () => history.back());
    await wait(30);
    expect(document.body.style.position).toBe('');
  });

  it('an autoFocus field of a layer stacked over a modal one keeps the focus although the browser refuses it before showModal()', async () => {
    // A browser treats everything outside the open modal dialog as inert: React's autoFocus on the new, not yet modal
    // dialog's field fails, and showModal() then focuses the first focusable element. happy-dom models neither.
    const modal = new WeakSet<Element>();
    const showModal = HTMLDialogElement.prototype.showModal;
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
      showModal.call(this);
      modal.add(this);
      this.querySelector<HTMLElement>('button, input')?.focus();
    });
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      const dialog = this.closest('dialog');
      const inert = dialog && !modal.has(dialog) && [...document.querySelectorAll('dialog')].some((other) => other !== dialog && modal.has(other));
      if (!inert) focus.call(this, options);
    });
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    await click('[data-testid="edit"]');
    await wait();
    await click('[data-testid="rename"]');
    await wait();
    expect(dialogs()).toHaveLength(2);
    expect(document.activeElement).toBe($('[data-testid="rename-field"]'));
    // The frame's temporary wrapper around focus() is gone again (restoreAllMocks would hide a leaked one).
    expect(HTMLElement.prototype.focus).toBe(spy);
    // Closing it gives the focus back to the link that opened it.
    await act(async () => history.back());
    await wait(30);
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe($('[data-testid="rename"]'));
  });

  it('without a modal layer beneath, the last element focused wins — as in the browser', async () => {
    const Two = () => (
      <>
        <h2>Two</h2>
        <input data-testid="first" autoFocus />
        <input data-testid="second" autoFocus />
      </>
    );
    const state = { key: 'two', depth: 1, isLayer: true, close: async () => {} } as unknown as LayerState;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LayerDialog layer={state} variant="modal">
          <Two />
        </LayerDialog>,
      );
    });
    await wait();
    expect(document.activeElement).toBe($('[data-testid="second"]'));
  });

  it('a layer that suspends again keeps its field and leaves focus() as it was', async () => {
    const before = HTMLElement.prototype.focus;
    let release: (() => void) | undefined;
    const Gate = ({ blocked }: { blocked: boolean }) => {
      if (blocked) throw new Promise<void>((resolve) => (release = resolve));
      return <input data-testid="gated" autoFocus />;
    };
    const state = { key: 'gate', depth: 1, isLayer: true, close: async () => {} } as unknown as LayerState;
    const tree = (blocked: boolean) => (
      <Suspense fallback={<p data-testid="fallback">…</p>}>
        <LayerDialog layer={state} variant="modal">
          <h2>Gate</h2>
          <button type="button">Delete</button>
          <Gate blocked={blocked} />
        </LayerDialog>
      </Suspense>
    );
    await act(async () => {
      root = createRoot(container);
      root.render(tree(false));
    });
    await wait();
    expect(document.activeElement).toBe($('[data-testid="gated"]'));
    await act(async () => root.render(tree(true)));
    expect(release).toBeDefined();
    expect($('[data-testid="fallback"]')).not.toBeNull();
    // The browser drops the focus from a hidden field.
    await act(async () => void (document.activeElement as HTMLElement | null)?.blur());
    await act(async () => {
      root.render(tree(false));
      release!();
    });
    await wait();
    expect($('[data-testid="fallback"]')).toBeNull();
    expect(document.activeElement).toBe($('[data-testid="gated"]'));
    expect(HTMLElement.prototype.focus).toBe(before);

    // Two dialogs in one commit: the wrapper is installed once and taken down again.
    await act(async () => {
      root.render(
        <>
          <LayerDialog layer={{ ...state, key: 'a' }} variant="modal">
            <h2>A</h2>
          </LayerDialog>
          <LayerDialog layer={{ ...state, key: 'b' }} variant="modal">
            <h2>B</h2>
          </LayerDialog>
        </>,
      );
    });
    await wait();
    expect(HTMLElement.prototype.focus).toBe(before);
  });

  it('an answer with another view replaces the layer in place: the dialog stays (never hidden while the view loads), named anew', async () => {
    server = (url, init) => {
      const { pathname } = new URL(url, location.href);
      if (pathname === '/islands/sign-ins') return respond(page('SignIns', pathname), { [REGION_HEADER]: 'island' });
      if (init.method === 'PUT') return respond({ ...page('Done', '/users/1'), layer: { key: 'app/Edit', base: '/users/1' } });
      return respond(layer('Edit', pathname, { name: 'Ada' }));
    };
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    await click('[data-testid="edit"]');
    await wait();
    const [dialog] = dialogs();
    const closes: string[] = [];
    dialog!.addEventListener('close', () => closes.push('closed'));
    await click('[data-testid="save"]');
    await wait(30);
    expect(dialogs()).toEqual([dialog]);
    expect(closes).toEqual([]); // not taken out of the modal state while the new view loaded
    expect(document.getElementById(dialog!.getAttribute('aria-labelledby')!)!.textContent).toBe('Done');
  });

  it('a second Escape before the layer is gone closes nothing more — not the layer beneath', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    await click('[data-testid="edit"]');
    await wait();
    await click('[data-testid="confirm"]');
    await wait();
    const top = dialogs()[1]!;
    await act(async () => {
      top.dispatchEvent(new Event('cancel', { cancelable: true }));
      top.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    await wait(40);
    expect(dialogs()).toHaveLength(1);
    expect(location.pathname).toBe('/users/1/edit');
  });

  it('closing two layers at once gives the focus back to what opened the lower one', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    const opener = $('[data-testid="edit"]') as HTMLAnchorElement;
    opener.focus();
    await act(async () => opener.click());
    await wait();
    const inner = $('[data-testid="confirm"]') as HTMLAnchorElement;
    inner.focus();
    await act(async () => inner.click());
    await wait();
    await click('[data-testid="close"]'); // the lower layer's — the one over it goes too
    await wait(40);
    expect(dialogs()).toEqual([]);
    expect(document.activeElement).toBe(opener);
  });

  it('a deep link’s document renders its layers over the page — on the server as in the browser', async () => {
    const document = { ...page('Profile', '/users/1', { name: 'Ada' }), layers: [layer('Edit', '/users/1/edit', { name: 'Ada' })] };
    const Profile = await resolve('app/Profile');
    // What createMarmeonApp and the SSR entry load before rendering a deep link: the layer stack, the layer's view.
    await Promise.all([loadLayerStack(), loadView(resolve, 'app/Edit')]);
    const html = renderToString(<MarmeonApp initialPage={document} initialComponent={Profile} resolve={resolve} routes={routes} />);
    expect(html).toContain('data-marmeon-layer="app/Edit"');
    expect(html).toContain('<dialog open=""');

    history.replaceState(null, '', '/users/1/edit');
    await mount(document);
    await wait();
    expect(dialogs()).toHaveLength(1);
    expect($('[data-testid="name"]')!.textContent).toBe('Ada');
  });

  it('useLayer() outside a layer: not a layer, depth 0 — a view can be both', async () => {
    await mount(page('AsPage', '/users/1'));
    expect($('[data-testid="as-page"]')!.textContent).toBe('false');
  });
});
