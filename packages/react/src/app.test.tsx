// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { PAGE_HEADER, type PageObject } from '@bespokecore/http/page';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BespokeApp, usePage, useRouter } from './app.tsx';
import { Head } from './head.tsx';
import { resolveModulePages, type DefaultLayout, type PageComponent } from './pages.ts';
import { showProgress, PROGRESS_ATTRIBUTE } from './progress.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A layout with state of its own: a counter. If the layout stays mounted, the count survives. */
function AppLayout({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const { visit } = useRouter();
  return (
    <div data-layout="app">
      <button data-testid="count" onClick={() => setCount(count + 1)}>
        {count}
      </button>
      <nav>
        <button data-testid="to-b" onClick={() => void visit('/b')} />
        <button data-testid="to-settings" onClick={() => void visit('/settings')} />
      </nav>
      {children}
    </div>
  );
}

function SettingsLayout({ children }: { children: ReactNode }) {
  const [opened] = useState(() => ++settingsMounts);
  return (
    <section data-layout="settings" data-mount={opened}>
      {children}
    </section>
  );
}
let settingsMounts = 0;

function A() {
  return (
    <p data-page="a">
      <Head title="Page A" />A
    </p>
  );
}
A.layout = AppLayout;

function B() {
  return <p data-page="b">B</p>;
}
B.layout = AppLayout;

function Settings() {
  return <p data-page="settings">Settings</p>;
}
Settings.layout = [AppLayout, SettingsLayout];

function Bare() {
  return <p data-page="bare">Bare</p>;
}
Bare.layout = null;

/** No layout of its own: gets the app's default. */
function Plain() {
  return <p data-page="plain">Plain</p>;
}

/** Throws unless its props are fresh — like a view after a hot update whose controller now sends another shape. */
function Fragile({ items }: { items: { data: string[] } | string[] }) {
  return <ul data-page="fragile">{(items as { data: string[] }).data.map((item) => <li key={item}>{item}</li>)}</ul>;
}
Fragile.layout = AppLayout;

const pages: Record<string, PageComponent> = { A, B, Settings, Bare, Plain, Fragile };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`../modules/app/views/${name}.tsx`, async () => ({ default: page })])));

const page = (name: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null });

let server: (url: string, init: RequestInit) => Response | Promise<Response>;
let root: Root;
let container: HTMLElement;

const respond = (body: PageObject, status = 200) => new Response(JSON.stringify(body), { status, headers: { [PAGE_HEADER]: 'true' } });

beforeEach(() => {
  history.replaceState(null, '', '/a');
  document.title = '';
  container = document.createElement('div');
  document.body.replaceChildren(container);
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => server(String(input), init ?? {}));
  vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports caught render errors
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

async function mount(initial: PageObject, options: { layout?: DefaultLayout; title?: (title: string) => string } = {}) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  await act(async () => {
    root.render(<BespokeApp initialPage={initial} initialComponent={Component} resolve={resolve} progress={false} {...options} />);
  });
}

const $ = (selector: string) => container.querySelector(selector);
const click = (testId: string) => act(async () => ($(`[data-testid="${testId}"]`) as HTMLButtonElement).click());
/** Lets fetches, renders and effects finish. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));

describe('persistent layouts (E35)', () => {
  it('keeps the layout mounted across navigations: its state survives', async () => {
    server = (url) => respond(page('B', new URL(url, location.href).pathname));
    await mount(page('A', '/a'));
    await click('count');
    await click('count');
    expect($('[data-testid="count"]')!.textContent).toBe('2');

    await click('to-b');
    await settle();
    expect($('[data-page="b"]')).not.toBeNull();
    expect($('[data-testid="count"]')!.textContent).toBe('2');

    // Back: the page from memory — and still the same layout.
    await act(async () => history.back());
    await settle();
    expect($('[data-page="a"]')).not.toBeNull();
    expect($('[data-testid="count"]')!.textContent).toBe('2');
  });

  it('nests layouts: the outer one stays, the inner one comes and goes', async () => {
    server = (url) => (url.endsWith('/settings') ? respond(page('Settings', '/settings')) : respond(page('B', '/b')));
    await mount(page('A', '/a'));
    await click('count');
    await click('to-settings');
    await settle();
    expect($('[data-layout="app"] [data-layout="settings"] [data-page="settings"]')).not.toBeNull();
    const mounts = settingsMounts;

    await click('to-b');
    await settle();
    expect($('[data-layout="settings"]')).toBeNull();
    expect($('[data-testid="count"]')!.textContent).toBe('1');
    await click('to-settings');
    await settle();
    expect(Number($('[data-layout="settings"]')!.getAttribute('data-mount'))).toBe(mounts + 1);
  });

  it('gives pages without their own layout the app’s default — and `layout = null` none at all', async () => {
    await mount(page('Plain', '/plain'), { layout: () => AppLayout });
    expect($('[data-layout="app"] [data-page="plain"]')).not.toBeNull();
    await act(async () => root.unmount());
    await mount(page('Bare', '/bare'), { layout: () => AppLayout });
    expect($('[data-layout="app"]')).toBeNull();
    expect($('[data-page="bare"]')).not.toBeNull();
  });

  it('counter-check: a layout rendered by the page itself (no `layout`) is remounted on every navigation', async () => {
    function Inline({ name }: { name: string }) {
      return (
        <AppLayout>
          <p data-page={name}>{name}</p>
        </AppLayout>
      );
    }
    const inline = resolveModulePages({ '../modules/app/views/Inline.tsx': async () => ({ default: Inline }) });
    server = () => respond({ component: 'app/Inline', props: { name: 'b' }, url: '/b', version: null });
    root = createRoot(container);
    await act(async () => root.render(<BespokeApp initialPage={{ component: 'app/Inline', props: { name: 'a' }, url: '/a' }} initialComponent={Inline} resolve={inline} progress={false} />));
    await click('count');
    await click('to-b');
    await settle();
    expect($('[data-page="b"]')).not.toBeNull();
    expect($('[data-testid="count"]')!.textContent).toBe('0'); // the state is gone
  });
});

describe('document title', () => {
  it('falls back to the default when the next page has no <Head title> (instead of keeping the old one)', async () => {
    server = () => respond(page('B', '/b'));
    await mount(page('A', '/a'), { title: (title) => (title ? `${title} — Shop` : 'Shop') });
    expect(document.title).toBe('Page A — Shop');
    await click('to-b');
    await settle();
    expect(document.title).toBe('Shop');
  });
});

describe('error boundaries', () => {
  it('shows the error page inside the layouts when a page throws — after one fresh copy of its props', async () => {
    let requests = 0;
    server = () => (requests++, respond(page('Fragile', '/fragile', { items: ['still', 'old'] })));
    await mount(page('Fragile', '/fragile', { items: ['old', 'shape'] }));
    await settle();

    expect(requests).toBe(1); // one retry, not a loop
    expect($('[data-layout="app"]')).not.toBeNull(); // the layout stands
    expect($('[data-layout="app"] h1')!.textContent).toBe('Something went wrong');
    await click('count'); // and still works
    expect($('[data-testid="count"]')!.textContent).toBe('1');
  });

  it('renders the page with fresh props from the server when those fit (a hot update changed their shape)', async () => {
    server = () => respond(page('Fragile', '/fragile', { items: { data: ['new', 'shape'] } }));
    await mount(page('Fragile', '/fragile', { items: ['old', 'shape'] }));
    await settle();
    expect([...container.querySelectorAll('[data-page="fragile"] li')].map((li) => li.textContent)).toEqual(['new', 'shape']);
  });

  it('counter-check: a page that renders fine is never fetched again', async () => {
    let requests = 0;
    server = () => (requests++, respond(page('B', '/b')));
    await mount(page('Fragile', '/fragile', { items: { data: ['fine'] } }));
    await settle();
    expect(requests).toBe(0);
  });
});

describe('failed visits', () => {
  it('shows a notice when the server cannot be reached — the page stays, nothing is rejected', async () => {
    server = () => {
      throw new TypeError('Failed to fetch');
    };
    await mount(page('A', '/a'));
    await click('count');
    await click('to-b');
    await settle();
    expect($('[data-bespoke-failure="network"]')!.textContent).toContain('could not be reached');
    expect($('[data-page="a"]')).not.toBeNull();
    expect($('[data-testid="count"]')!.textContent).toBe('1');
    expect(location.pathname).toBe('/a');
  });

  it('shows the server’s error page over the page on a 5xx, with the exception in debug mode', async () => {
    const exception = { name: 'TypeError', message: 'boom', stack: 'TypeError: boom\n    at ShowController.handle' };
    server = () => respond({ component: 'errors/Error', props: { status: 500, title: 'Internal Server Error', message: 'boom', exception }, url: '/b', version: null }, 500);
    await mount(page('A', '/a'));
    await click('to-b');
    await settle();
    const dialog = $('dialog[data-bespoke-failure="server"]')!;
    expect(dialog.querySelector('h1')!.textContent).toBe('Internal Server Error');
    expect(dialog.querySelector('pre')!.textContent).toContain('at ShowController.handle');
    expect($('[data-page="a"]')).not.toBeNull();

    // A visit that works clears it.
    server = () => respond(page('B', '/b'));
    await click('to-b');
    await settle();
    expect($('[data-bespoke-failure]')).toBeNull();
  });
});

describe('progress bar', () => {
  /** A navigator's event source, driven by hand. */
  function events() {
    const listeners = new Map<string, Set<(...args: never[]) => void>>();
    return {
      on: ((event: string, listener: (...args: never[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
        return () => listeners.get(event)!.delete(listener);
      }) as never,
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) (listener as (...args: unknown[]) => void)(...args);
      },
    };
  }
  const bar = () => document.querySelector<HTMLElement>(`[${PROGRESS_ATTRIBUTE}]`);
  const visit = { url: '/b', method: 'get' };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('appears only for visits slower than the delay, and goes away when they finish', () => {
    const source = events();
    const stop = showProgress(source, { delay: 250 });

    source.emit('start', visit);
    vi.advanceTimersByTime(200);
    source.emit('finish', visit);
    vi.advanceTimersByTime(1000);
    expect(bar()).toBeNull(); // fast: never shown

    source.emit('start', visit);
    vi.advanceTimersByTime(300);
    expect(bar()).not.toBeNull();
    expect(bar()!.style.background).toContain('--bespoke-progress-color');
    source.emit('progress', { loaded: 50, total: 100, percentage: 50 }, visit);
    expect(bar()!.style.transform).toBe('scaleX(0.45)');
    source.emit('finish', visit);
    vi.advanceTimersByTime(1000);
    expect(bar()).toBeNull();
    stop();
  });

  it('stays while any request runs (a cancelled one finishing does not end the newer one)', () => {
    const source = events();
    const stop = showProgress(source, { delay: 0 });
    source.emit('start', visit);
    source.emit('start', visit);
    vi.advanceTimersByTime(10);
    source.emit('cancel', visit);
    source.emit('finish', visit);
    vi.advanceTimersByTime(1000);
    expect(bar()).not.toBeNull();
    source.emit('finish', visit);
    vi.advanceTimersByTime(1000);
    expect(bar()).toBeNull();
    stop();
  });
});

describe('usePage inside layouts', () => {
  it('gives layouts the shared props of the current page', async () => {
    function Shared({ children }: { children: ReactNode }) {
      const { props } = usePage<{ flash: string }>();
      return (
        <div data-flash={props.flash}>
          <button data-testid="to-b" onClick={() => void 0} />
          {children}
        </div>
      );
    }
    await mount(page('Plain', '/plain', { flash: 'Saved.' }), { layout: () => Shared });
    expect($('[data-flash="Saved."] [data-page="plain"]')).not.toBeNull();
  });
});
