// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/people" }
import { PAGE_HEADER, PARTIAL_DATA_HEADER, type PageObject, type RouteManifest } from '@bespokecore/http/page';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BespokeApp } from './app.tsx';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { useQueryState } from './use-query-state.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULTS = { q: '', sort: 'name' };
const routes: RouteManifest = { people: { method: 'get', path: '/people' }, show: { method: 'get', path: '/users/:user' } };

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

function Misplaced() {
  useQueryState('people');
  return null;
}

const pages: Record<string, PageComponent> = { People, Misplaced };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`../modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const NAMES = ['Ada', 'Alan', 'Grace'];
const peoplePage = (url: string): PageObject => {
  const search = new URL(url, 'https://app.test').searchParams;
  const q = (search.get('q') ?? '').trim();
  const sort = search.get('sort') === '-name' ? '-name' : 'name';
  const people = NAMES.filter((name) => name.toLowerCase().includes(q.toLowerCase()));
  if (sort === '-name') people.reverse();
  return { component: 'app/People', url, props: { people }, version: null, query: { ...(q ? { q } : {}), ...(sort !== 'name' ? { sort } : {}) }, queryDefaults: DEFAULTS };
};

let requests: { url: string; headers: Record<string, string> }[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/people');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  requests = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    requests.push({ url: String(input), headers: { ...(init.headers as Record<string, string>) } });
    return new Response(JSON.stringify(peoplePage(String(input))), { headers: { [PAGE_HEADER]: 'true' } });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

async function mount(initial: PageObject) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  await act(async () => root.render(<BespokeApp initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} progress={false} />));
}

const $ = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
const wait = (ms: number) => act(async () => void (await new Promise((done) => setTimeout(done, ms))));
/** Types into a controlled React input (the value setter React listens to, then an input event). */
const type = (testId: string, value: string) =>
  act(async () => {
    const input = $(testId) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('useQueryState (E55)', () => {
  it('shows what is typed at once and visits once per pause — a partial reload, the entry replaced', async () => {
    await mount(peoplePage('/people'));
    expect(($('q') as HTMLInputElement).value).toBe('');
    await type('q', 'a');
    await type('q', 'al');
    expect(($('q') as HTMLInputElement).value).toBe('al');
    expect(requests).toHaveLength(0);
    await wait(80);
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
    await wait(10);
    expect(location.search).toBe('?q=a&sort=-name');
    expect($('sort').textContent).toBe('-name');
    expect($('list').textContent).toBe('Grace,Alan,Ada'); // replaced (reset), not merged
    await act(async () => history.back());
    await wait(20);
    expect($('sort').textContent).toBe('name');
    expect(($('q') as HTMLInputElement).value).toBe('a');
  });

  it('belongs to the page of its route — elsewhere it throws a readable error (the page’s error boundary shows it)', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args));
    await mount({ component: 'app/Misplaced', url: '/users/1', props: {}, version: null });
    expect(JSON.stringify(errors.map(String))).toContain('is used on /users/1, a page of another route');
  });
});
