// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/people" }
/**
 * Query state in the client core (E55), driven by a plain-DOM adapter: the adapter renders `state.value()` and calls
 * `set()` — debouncing, partial reloads, history and Back/Forward are the core's.
 */
// happy-dom has no Navigation API: the History fallback writes the history — as an adapter attaches it there (E184).
import { historyFallback } from './features/history-fallback.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, type PageObject } from '../page.ts';
import { assertQueryPage, linkQuery, Navigator, pageQuery, queryState, queryUrl, withoutDefaults } from './index.ts';

const DEFAULTS = { q: '', sort: 'name' };
const PEOPLE = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Hedy Lamarr'];
const requests: { url: string; headers: Record<string, string> }[] = [];
let slow: Promise<void> | undefined;

/** `/people?q=&sort=` as the server answers it: the query parsed (trimmed, an unknown sort falls back), `people` merged. */
async function server(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, 'https://app.test');
  const headers = { ...(init.headers as Record<string, string>) };
  requests.push({ url: url.pathname + url.search, headers });
  await slow;
  const q = (url.searchParams.get('q') ?? '').trim();
  const sort = ['name', '-name'].includes(url.searchParams.get('sort') ?? '') ? url.searchParams.get('sort')! : 'name';
  const people = PEOPLE.filter((name) => name.toLowerCase().includes(q.toLowerCase()));
  if (sort === '-name') people.reverse();
  const query = withoutDefaults({ q, sort }, DEFAULTS) as Record<string, unknown>;
  const partial = headers[PARTIAL_COMPONENT_HEADER] === 'people/List' ? headers[PARTIAL_DATA_HEADER]?.split(',') : undefined;
  const props = partial ? { people } : { people, title: 'People' };
  const body: PageObject = { component: 'people/List', url: url.pathname + url.search, props, query, queryDefaults: DEFAULTS, mergeProps: ['people'] };
  return new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: 'true', 'content-type': 'application/json' } });
}

function start(url = '/people') {
  window.history.replaceState(null, '', url);
  const initialPage: PageObject = { component: 'people/List', url, props: { people: PEOPLE, title: 'People' }, query: {}, queryDefaults: DEFAULTS, mergeProps: ['people'] };
  let rendered = initialPage;
  const navigator = new Navigator({ features: [historyFallback], initialPage, render: async (page) => void (rendered = page) });
  const stop = navigator.start();
  return { navigator, page: () => rendered, stop };
}

afterEach(() => {
  requests.length = 0;
  slow = undefined;
});

describe('query state in the client core (no UI framework)', () => {
  it('builds URLs without the defaults, and reads the parsed query of a page (it never parses one)', () => {
    expect(queryUrl({ url: '/people?q=old', queryDefaults: DEFAULTS }, { q: 'ada', sort: 'name', cursor: undefined })).toBe('/people?q=ada');
    expect(queryUrl({ url: '/people', queryDefaults: DEFAULTS }, { q: '', sort: '-name', tags: ['a', 'b'] })).toBe('/people?sort=-name&tags=a&tags=b');
    expect(pageQuery({ query: { sort: '-name' }, queryDefaults: DEFAULTS })).toEqual({ q: '', sort: '-name' });
    expect(linkQuery({ url: '/people?q=a', queryDefaults: DEFAULTS }, '/people', { q: 'a', sort: 'name' })).toEqual({ q: 'a' });
    expect(linkQuery({ url: '/people', queryDefaults: DEFAULTS }, '/users/1', { sort: 'name' })).toEqual({ sort: 'name' }); // another page: as given
  });

  it('belongs to its route’s page — elsewhere it says so', () => {
    expect(() => assertQueryPage('people', '/people', { url: '/users/1', queryDefaults: {} })).toThrow(
      'Query state of [people] (/people) is used on /users/1, a page of another route — it belongs to the page of its route.',
    );
    expect(() => assertQueryPage('show', '/users/:user', { url: '/users/1' })).toThrow('Route [show] has no query schema to keep state in');
    expect(() => assertQueryPage('show', '/users/:user{[0-9]+}', { url: '/users/12', queryDefaults: {} })).not.toThrow();
  });

  it('typing: the state changes at once, the URL once per pause — one partial reload, replacing the history entry, the list replaced', async () => {
    window.fetch = server as typeof fetch;
    const { navigator, page, stop } = start();
    const state = navigator.use(queryState).create<{ q: string; sort: string }>({ only: ['people'], debounce: 20, history: 'replace' });
    const length = window.history.length;

    for (const q of ['a', 'al', 'ala']) state.set({ q });
    expect(state.value()).toEqual({ q: 'ala', sort: 'name' }); // what is typed shows before any request
    expect(requests).toHaveLength(0);
    await vi.waitFor(() => expect(window.location.search).toBe('?q=ala'));
    expect(requests).toEqual([{ url: '/people?q=ala', headers: expect.objectContaining({ [PARTIAL_DATA_HEADER]: 'people' }) }]);
    expect(window.history.length).toBe(length); // replaced, not pushed
    // `people` is a merge() prop: a new query replaces the list instead of appending to it.
    expect(page().props.people).toEqual(['Alan Turing']);
    expect(page().query).toEqual({ q: 'ala' });
    stop();
    state.dispose();
  });

  it('keeps what is typed while a request is on its way — and what the server normalized away (a trailing space)', async () => {
    window.fetch = server as typeof fetch;
    const { navigator, stop } = start();
    const state = navigator.use(queryState).create<{ q: string; sort: string }>({ only: ['people'], debounce: 10, history: 'replace' });
    let release!: () => void;
    slow = new Promise((done) => (release = done));
    state.set({ q: 'ada ' });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    state.set({ q: 'ada l' }); // typed on while the first answer is out
    release();
    await vi.waitFor(() => expect(window.location.search).toBe('?q=ada+l'));
    expect(state.value().q).toBe('ada l');
    slow = undefined;
    state.set({ q: 'ada ' });
    await vi.waitFor(() => expect(navigator.page.query).toEqual({ q: 'ada' }));
    expect(state.value().q).toBe('ada '); // the server trimmed — the field keeps the space being typed
    stop();
    state.dispose();
  });

  it('a function of the current state, `undefined` for the default — and Back/Forward bring the state of their entry', async () => {
    window.fetch = server as typeof fetch;
    const { navigator, stop } = start();
    const state = navigator.use(queryState).create<{ q: string; sort: string }>({ only: ['people'] });
    state.set((current) => ({ sort: current.sort === 'name' ? '-name' : 'name' }));
    await vi.waitFor(() => expect(window.location.search).toBe('?sort=-name'));
    state.set({ q: 'a' });
    await vi.waitFor(() => expect(window.location.search).toBe('?q=a&sort=-name'));
    state.set({ sort: undefined });
    await vi.waitFor(() => expect(window.location.search).toBe('?q=a'));

    const asked = requests.length;
    window.history.back();
    await vi.waitFor(() => expect(state.value()).toEqual({ q: 'a', sort: '-name' }));
    window.history.back();
    await vi.waitFor(() => expect(state.value()).toEqual({ q: '', sort: '-name' }));
    window.history.forward();
    await vi.waitFor(() => expect(state.value()).toEqual({ q: 'a', sort: '-name' }));
    expect(requests.length).toBe(asked); // from memory
    stop();
    state.dispose();
  });

  it('"load more" with preserveUrl keeps the query of the page on screen, not the one it asked with', async () => {
    window.fetch = server as typeof fetch;
    const { navigator, stop } = start('/people?q=a');
    await navigator.visit('/people?q=a&sort=-name', { only: ['people'], preserveUrl: true });
    expect(navigator.page.url).toBe('/people?q=a');
    expect(navigator.page.query).toEqual({});
    stop();
  });

  it('drops a change still waiting when it is disposed (the page was left)', async () => {
    window.fetch = server as typeof fetch;
    const { navigator, stop } = start();
    const state = navigator.use(queryState).create({ debounce: 10 });
    state.set({ q: 'x' });
    state.dispose();
    await new Promise((done) => setTimeout(done, 30));
    expect(requests).toHaveLength(0);
    stop();
  });
});
