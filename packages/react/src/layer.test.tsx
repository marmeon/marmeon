// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1" }
import { LAYER_CLOSE_HEADER, PAGE_HEADER, REGION_HEADER, type PageObject, type RouteManifest } from '@bespokecore/http/page';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BespokeApp, loadLayerStack, usePage, useRouter } from './app.tsx';
import { Head } from './head.tsx';
import { Island } from './island.tsx';
import { useLayer } from './layer.tsx';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { loadView } from './views.ts';

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

const pages: Record<string, PageComponent> = { Profile, Edit, Confirm, SignIns, AsPage, Done };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`../modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const routes: RouteManifest = {
  edit: { method: 'get', path: '/users/1/edit' },
  confirm: { method: 'get', path: '/users/1/confirm' },
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
  requests = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    requests.push({ url: String(input), method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) } });
    return server(String(input), init);
  });
  server = (url, init) => {
    const { pathname } = new URL(url, location.href);
    if (pathname === '/islands/sign-ins') return respond(page('SignIns', pathname), { [REGION_HEADER]: 'island' });
    if (pathname === '/users/1/edit') return respond(layer('Edit', pathname, { name: 'Ada' }));
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
  await act(async () => root.render(<BespokeApp initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} />));
}

const $ = (selector: string) => container.querySelector(selector);
const wait = (ms = 10) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const click = (selector: string) => act(async () => ($(selector) as HTMLElement).click());
const dialogs = () => [...container.querySelectorAll('dialog[data-bespoke-layer]')];

describe('Layers in React (E53)', () => {
  it('<Link layer> opens the view in a modal dialog over the page — the page stays, its island is not loaded again', async () => {
    await mount(page('Profile', '/users/1', { name: 'Ada' }));
    await wait();
    const islands = () => requests.filter((request) => request.headers[REGION_HEADER] === 'island').length;
    expect(islands()).toBe(1);
    const heading = $('[data-testid="name"]');

    await click('[data-testid="edit"]');
    // The first layer of the file: the stack's chunk loads with it (E71) — under a busy test run, that may take more than a tick.
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
    // Counter-check: closing does not load the page's island again (its owner stays the page's).
    expect(islands()).toBe(1);
  });

  it('counter-check: focus goes back to the link that opened the layer when it closes', async () => {
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

  it('a form inside the layer shows its optimistic patch while it is sent — the layer’s, gone when the answer lands (E59)', async () => {
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
    expect(requests.at(-1)).toMatchObject({ url: '/users/1', headers: { 'x-bespoke-partial-data': 'name' } });
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
    // What createBespokeApp and the SSR entry load before rendering a deep link (E71): the layer stack, the layer's view.
    await Promise.all([loadLayerStack(), loadView(resolve, 'app/Edit')]);
    const html = renderToString(<BespokeApp initialPage={document} initialComponent={Profile} resolve={resolve} routes={routes} />);
    expect(html).toContain('data-bespoke-layer="app/Edit"');
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
