// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { PAGE_HEADER, type PageObject } from '@marmeon/http/page';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, usePage, useRouter } from './app.tsx';
import { Deferred } from './deferred.tsx';
import { Head } from './head.tsx';
import { resolveModulePages, type DefaultLayout, type PageComponent } from './pages.ts';
import { useForm } from './use-form.ts';
import { loadHistoryFallback } from '@marmeon/http/client';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

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

/** A form: what its callbacks were called with. */
const calls: unknown[] = [];
function Form() {
  const form = useForm<{ name: string }>({ name: '' });
  return (
    <button
      data-testid="submit"
      onClick={() =>
        void form.post('/form', {
          onSuccess: () => calls.push('success'),
          onError: (errors) => calls.push({ error: errors }),
          onException: (exception) => calls.push({ exception: exception.type }),
          onFinish: () => calls.push('finish'),
        })
      }
    />
  );
}

/** A page with a deferred prop and an optional one (`reload({ only })`), inside the app layout. */
function Profile({ name, activity, stats }: { name: string; activity?: string[]; stats?: { links: number } }) {
  const router = useRouter<{ name: string; activity?: string[]; stats?: { links: number } }>();
  return (
    <div data-page="profile">
      <h1>{name}</h1>
      <Deferred data="activity" fallback={<p data-testid="loading">Loading…</p>}>
        {() => <ul data-testid="activity">{activity!.map((entry) => <li key={entry}>{entry}</li>)}</ul>}
      </Deferred>
      {stats ? <p data-testid="stats">{stats.links}</p> : <button data-testid="show-stats" onClick={() => void router.reload({ only: ['stats'] })} />}
    </div>
  );
}
Profile.layout = AppLayout;

const pages: Record<string, PageComponent> = { A, B, Settings, Bare, Plain, Fragile, Form, Profile };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));

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
    root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} {...options} />);
  });
}

const $ = (selector: string) => container.querySelector(selector);
const click = (testId: string) => act(async () => ($(`[data-testid="${testId}"]`) as HTMLButtonElement).click());
/** Lets fetches, renders and effects finish. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 10))));
/** What a failure shows is a chunk of its own: under a busy test run it may take more than a tick to load. */
const shown = async (selector: string) => {
  for (let tries = 0; tries < 200 && !$(selector); tries++) await settle();
  return $(selector);
};
/** The deferred request goes out only after its loader chunk has arrived. */
const requested = async (requests: unknown[]) => {
  for (let tries = 0; tries < 200 && requests.length === 0; tries++) await settle();
};

describe('persistent layouts', () => {
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

  it('a layout rendered by the page itself (no `layout`) is remounted on every navigation', async () => {
    function Inline({ name }: { name: string }) {
      return (
        <AppLayout>
          <p data-page={name}>{name}</p>
        </AppLayout>
      );
    }
    const inline = resolveModulePages({ '/modules/app/views/Inline.tsx': async () => ({ default: Inline }) });
    server = () => respond({ component: 'app/Inline', props: { name: 'b' }, url: '/b', version: null });
    root = createRoot(container);
    await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={{ component: 'app/Inline', props: { name: 'a' }, url: '/a' }} initialComponent={Inline} resolve={inline} />));
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
    expect((await shown('[data-layout="app"] h1'))!.textContent).toBe('Something went wrong');
    await click('count'); // and still works
    expect($('[data-testid="count"]')!.textContent).toBe('1');
  });

  it('renders the page with fresh props from the server when those fit (a hot update changed their shape)', async () => {
    server = () => respond(page('Fragile', '/fragile', { items: { data: ['new', 'shape'] } }));
    await mount(page('Fragile', '/fragile', { items: ['old', 'shape'] }));
    await settle();
    expect([...container.querySelectorAll('[data-page="fragile"] li')].map((li) => li.textContent)).toEqual(['new', 'shape']);
  });

  it('a page that renders fine is never fetched again', async () => {
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
    expect($('[data-marmeon-failure="network"]')!.textContent).toContain('could not be reached');
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
    const dialog = (await shown('dialog[data-marmeon-failure="server"] pre'))!.closest('dialog')!;
    expect(dialog.querySelector('h1')!.textContent).toBe('Internal Server Error');
    expect(dialog.querySelector('pre')!.textContent).toContain('at ShowController.handle');
    expect($('[data-page="a"]')).not.toBeNull();

    // A visit that works clears it.
    server = () => respond(page('B', '/b'));
    await click('to-b');
    await settle();
    expect($('[data-marmeon-failure]')).toBeNull();
  });
});

describe('form callbacks', () => {
  it('onError gets the validation errors (first message per field), onException a failed request', async () => {
    calls.length = 0;
    server = () => respond(page('Form', '/form', { errors: { name: ['The name is required.', 'Too short.'] } }));
    await mount(page('Form', '/form'));
    await click('submit');
    await settle();
    expect(calls).toEqual([{ error: { name: 'The name is required.' } }, 'finish']);

    calls.length = 0;
    server = () => respond(page('Form', '/form', { errors: {} }));
    await click('submit');
    await settle();
    expect(calls).toEqual(['success', 'finish']);

    calls.length = 0;
    server = () => {
      throw new TypeError('Failed to fetch');
    };
    await click('submit');
    await settle();
    expect(calls).toEqual([{ exception: 'network' }, 'finish']);
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

describe('deferred and optional props', () => {
  it('renders the page with the fallback first, then the deferred prop the browser loads after mount', async () => {
    let release!: () => void;
    const requests: Record<string, string>[] = [];
    server = async (_url, init) => {
      requests.push(init.headers as Record<string, string>);
      await new Promise<void>((done) => (release = done)); // a slow server
      return respond(page('Profile', '/a', { activity: ['signed in'] }));
    };
    await mount({ ...page('Profile', '/a', { name: 'Ada' }), deferredProps: { default: ['activity'] } });
    await click('count');
    await requested(requests);

    // On screen without it — the request for it is out.
    expect($('[data-testid="loading"]')).not.toBeNull();
    expect($('h1')!.textContent).toBe('Ada');
    expect(requests).toEqual([expect.objectContaining({ 'x-marmeon-partial-component': 'app/Profile', 'x-marmeon-partial-data': 'activity' })]);

    release();
    await settle();
    expect($('[data-testid="loading"]')).toBeNull();
    expect($('[data-testid="activity"]')!.textContent).toBe('signed in');
    expect($('[data-testid="count"]')!.textContent).toBe('1'); // layout and page state kept
  });

  it('loads an optional prop on request — merged into the page, the rest kept', async () => {
    server = () => respond(page('Profile', '/a', { stats: { links: 3 } }));
    await mount(page('Profile', '/a', { name: 'Ada', activity: ['joined'] }));
    await click('show-stats');
    await settle();
    expect($('[data-testid="stats"]')!.textContent).toBe('3');
    expect($('h1')!.textContent).toBe('Ada');
    expect($('[data-testid="activity"]')!.textContent).toBe('joined');
  });
});
