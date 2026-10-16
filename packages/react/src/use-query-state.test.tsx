// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/people" }
import type { RouteManifest } from '@marmeon/http/page';
import { PAGE_HEADER, PARTIAL_DATA_HEADER, type PageObject } from '@marmeon/http/protocol';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp } from './app.tsx';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { useQueryState } from './use-query-state.ts';
import { loadHistoryFallback } from '@marmeon/http/client/adapter';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULTS = { q: '', sort: 'name' };
const routes: RouteManifest = { people: { method: 'get', path: '/people' }, find: { method: 'get', path: '/people/find' }, show: { method: 'get', path: '/users/:user' } };

function People({ people }: { people: string[] }) {
  const [query, setQuery] = useQueryState('people', { only: ['people'], debounce: 30, history: 'replace' });
  return (
    <main>
      <input data-testid="q" value={query.q as string} onChange={(event) => setQuery({ q: event.target.value })} />
      <Link route="people" query={{ ...query, sort: '-name' }} only={['people']} reset={['people']} data-testid="desc">
        Z–A
      </Link>
      <output data-testid="sort">{query.sort as string}</output>
      <ul data-testid="list">{people.join(',')}</ul>
    </main>
  );
}

/** A child that sets the state as it mounts — its effect runs before the hook's own (children first). */
function SortOnMount({ set }: { set: (update: { sort: string }) => void }) {
  useEffect(() => set({ sort: '-name' }), [set]);
  return null;
}

function Early({ people }: { people: string[] }) {
  const [query, setQuery] = useQueryState('people', { only: ['people'], history: 'replace' });
  return (
    <main>
      <SortOnMount set={setQuery} />
      <output data-testid="sort">{query.sort as string}</output>
      <ul data-testid="list">{people.join(',')}</ul>
    </main>
  );
}

/** The page with a link that opens `Find` as a layer over it. */
function Directory({ people }: { people: string[] }) {
  return (
    <main>
      <Link route="find" layer data-testid="open">
        Find
      </Link>
      <ul data-testid="list">{people.join(',')}</ul>
    </main>
  );
}

/** A layer with a search field: its query state belongs to the layer. */
function Find({ people }: { people: string[] }) {
  const [query, setQuery] = useQueryState('find', { only: ['people'], history: 'replace' });
  return (
    <section>
      <h2>Find</h2>
      <input data-testid="lq" value={query.q as string} onChange={(event) => setQuery({ q: event.target.value })} />
      <ul data-testid="found">{people.join(',')}</ul>
    </section>
  );
}

/** The same layer without `only`: every prop comes again, and the input must not remount. */
function FindAll({ people }: { people: string[] }) {
  const [query, setQuery] = useQueryState('find');
  return (
    <section>
      <h2>Find</h2>
      <input data-testid="lq" value={query.q as string} onChange={(event) => setQuery({ q: event.target.value })} />
      <ul data-testid="found">{people.join(',')}</ul>
    </section>
  );
}

function Misplaced() {
  useQueryState('people');
  return null;
}

const pages: Record<string, PageComponent> = { People, Early, Misplaced, Directory, Find, FindAll };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const NAMES = ['Ada', 'Alan', 'Grace'];
const peoplePage = (url: string): PageObject => {
  const search = new URL(url, 'https://app.test').searchParams;
  const q = (search.get('q') ?? '').trim();
  const sort = search.get('sort') === '-name' ? '-name' : 'name';
  const people = NAMES.filter((name) => name.toLowerCase().includes(q.toLowerCase()));
  if (sort === '-name') people.reverse();
  return { component: 'app/People', url, props: { people }, version: null, query: { ...(q ? { q } : {}), ...(sort !== 'name' ? { sort } : {}) }, queryDefaults: DEFAULTS };
};

let layerView = 'app/Find';
const component = () => layerView;
let gate: Promise<void> | undefined;
let requests: { url: string; headers: Record<string, string> }[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/people');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  requests = [];
  gate = undefined;
  layerView = 'app/Find';
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    requests.push({ url: String(input).replace(window.location.origin, ''), headers: { ...(init.headers as Record<string, string>) } });
    if (new URL(String(input).replace(window.location.origin, ''), location.href).pathname === '/people/find') {
      if (String(input).replace(window.location.origin, '').includes('q=')) await gate;
      const found = peoplePage(String(input).replace(window.location.origin, '').replace('/people/find', '/people'));
      return new Response(JSON.stringify({ ...found, component: component(), url: String(input).replace(window.location.origin, ''), layer: { key: 'app/Find', base: '/people' } }), { headers: { [PAGE_HEADER]: 'true' } });
    }
    return new Response(JSON.stringify(peoplePage(String(input).replace(window.location.origin, ''))), { headers: { [PAGE_HEADER]: 'true' } });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

async function mount(initial: PageObject) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} />));
}

const $ = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
const wait = (ms: number) => act(async () => void (await new Promise((done) => setTimeout(done, ms))));
/** Until the assertion holds — React gets a turn (act) between the tries; never a fixed time that a loaded machine overruns. */
async function until(assertion: () => void, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await wait(5);
    try {
      return assertion();
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
}
/** Types into a controlled React input (the value setter React listens to, then an input event) — synchronously, in one act. */
const typeNow = (testId: string, value: string) =>
  act(() => {
    const input = $(testId) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('useQueryState', () => {
  it('shows what is typed at once and visits once per pause — a partial reload, the entry replaced', async () => {
    await mount(peoplePage('/people'));
    expect(($('q') as HTMLInputElement).value).toBe('');
    // Two keys with no turn of the event loop between them (synchronous act): however long a loaded machine takes, the pause
    // cannot end in between.
    typeNow('q', 'a');
    typeNow('q', 'al');
    expect(($('q') as HTMLInputElement).value).toBe('al');
    expect(requests).toHaveLength(0);
    await until(() => expect($('list').textContent).toBe('Alan'));
    expect(requests.map((r) => r.url)).toEqual(['/people?q=al']);
    expect(requests[0]!.headers).toMatchObject({ [PARTIAL_DATA_HEADER]: 'people' });
    expect(location.search).toBe('?q=al');
    expect($('list').textContent).toBe('Alan');
    expect(($('q') as HTMLInputElement).value).toBe('al');
  });

  it('a typed link keeps the state, leaves the defaults out of its URL, and Back brings the earlier state back', async () => {
    await mount(peoplePage('/people?q=a'));
    expect($('desc').getAttribute('href')).toBe('/people?q=a&sort=-name');
    await act(async () => $('desc').click());
    await until(() => expect($('sort').textContent).toBe('-name'));
    expect(location.search).toBe('?q=a&sort=-name');
    expect($('list').textContent).toBe('Grace,Alan,Ada'); // replaced (reset), not merged
    await act(async () => history.back());
    await until(() => expect($('sort').textContent).toBe('name'));
    expect(($('q') as HTMLInputElement).value).toBe('a');
  });

  it('a set() before the state exists (a child’s effect on mount) is made once it does — never dropped', async () => {
    await mount({ ...peoplePage('/people'), component: 'app/Early' });
    await until(() => expect($('list').textContent, 'the early set() was dropped').toBe('Grace,Alan,Ada'), 2000);
    expect($('sort').textContent).toBe('-name');
    expect(location.search).toBe('?sort=-name');
  });

  it('belongs to the page of its route — elsewhere it throws a readable error (the page’s error boundary shows it)', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));
    await mount({ component: 'app/Misplaced', url: '/users/1', props: {}, version: null });
    expect(JSON.stringify(errors.map(String))).toContain('is used on /users/1, a page of another route');
  });

  it('inside a layer it is the layer’s query: typing visits the layer in place, the page beneath stays, one Back closes it', async () => {
    await mount({ ...peoplePage('/people'), component: 'app/Directory' });
    await act(async () => $('open').click());
    await until(() => expect($('lq')).not.toBeNull(), 5000);
    const opened = requests.length;
    const entries = history.length;

    typeNow('lq', 'al');
    await until(() => expect($('found').textContent).toBe('Alan'));
    const sent = requests.slice(opened);
    expect(sent.map((r) => r.url)).toEqual(['/people/find?q=al']);
    expect(sent[0]!.headers).toMatchObject({ 'x-marmeon-region': 'layer', [PARTIAL_DATA_HEADER]: 'people' });
    expect(history.length).toBe(entries);
    expect(location.pathname + location.search).toBe('/people/find?q=al');
    // The page beneath: never asked for, its props as they were.
    expect(requests.some((r) => r.url.startsWith('/people?'))).toBe(false);
    expect($('list').textContent).toBe('Ada,Alan,Grace');
    expect(container.ownerDocument.querySelector('dialog[data-marmeon-layer]')).not.toBeNull();

    await act(async () => history.back());
    await until(() => expect(container.ownerDocument.querySelector('dialog[data-marmeon-layer]')).toBeNull());
    expect(location.pathname + location.search).toBe('/people');
  });

  it('a layer closed while its search is out stays closed — the answer neither opens it again nor adds an entry', async () => {
    await mount({ ...peoplePage('/people'), component: 'app/Directory' });
    await act(async () => $('open').click());
    await until(() => expect($('lq')).not.toBeNull(), 5000);
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));

    typeNow('lq', 'al');
    await until(() => expect(requests.some((r) => r.url === '/people/find?q=al')).toBe(true));
    await act(async () => void container.ownerDocument.querySelector('dialog[data-marmeon-layer]')!.dispatchEvent(new Event('cancel', { cancelable: true })));
    await until(() => expect(container.ownerDocument.querySelector('dialog[data-marmeon-layer]')).toBeNull());
    const entries = history.length;
    release();
    await wait(50);
    expect(container.ownerDocument.querySelector('dialog[data-marmeon-layer]')).toBeNull();
    expect(history.length).toBe(entries);
    expect(location.pathname).toBe('/people');
  });

  it('without only, the layer stays the same object: the input keeps its element and focus, and the entry is replaced', async () => {
    layerView = 'app/FindAll';
    await mount({ ...peoplePage('/people'), component: 'app/Directory' });
    await act(async () => $('open').click());
    await until(() => expect($('lq')).not.toBeNull(), 5000);
    const input = $('lq');
    input.focus();
    const entries = history.length;

    typeNow('lq', 'al');
    await until(() => expect($('found').textContent).toBe('Alan'));
    expect($('lq')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(history.length).toBe(entries);
    expect(location.search).toBe('?q=al');
  });
});
