// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1" }
import { remember } from '@marmeon/http/client/adapter';
import { loadHistoryFallback, type Navigator, type RegionOwner } from '@marmeon/http/client/adapter';
import type { RouteManifest } from '@marmeon/http/page';
import { LOCATION_HEADER, PAGE_HEADER, RELOAD_HEADER, type PageObject } from '@marmeon/http/protocol';
import { act, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, RegionOwnerContext, useRouterContext } from './app.tsx';
import { Form } from './form.tsx';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { useRemember } from './remember.ts';
import { useNewVersion } from './state.ts';
import { useForm } from './use-form.ts';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Remember state, `<Form>`, instant visits and the new-version banner in React. */

let navigator: Navigator | null = null;
let owner: RegionOwner | null = null;

/** Reads what the tests inspect: the navigator and the region owner (where remembered state lives) of the page on screen. */
function Probe() {
  navigator = useRouterContext().navigator();
  owner = useContext(RegionOwnerContext);
  const waiting = useNewVersion();
  return <p data-testid="new-version">{waiting?.location ?? ''}</p>;
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Probe />
      <Link href="/people" data-testid="to-people">
        People
      </Link>
      <Link route="profile.show" data-testid="to-grace" instant={{ name: 'Grace' } as never}>
        Grace
      </Link>
      <main>{children}</main>
    </>
  );
}

function Edit({ name }: { name: string }) {
  const [tab, setTab] = useRemember('tab', 'links');
  const form = useForm('profile.update', {}, { name, password: '', card_number: '' }, { remember: true, guard: 'Unsaved.' });
  return (
    <>
      <button data-testid="tab" onClick={() => setTab('activity')}>
        {tab}
      </button>
      <input data-testid="name" value={String(form.data.name)} onChange={(event) => form.set('name', event.target.value)} />
      <input data-testid="password" type="password" value={String(form.data.password)} onChange={(event) => form.set('password', event.target.value)} />
      <input data-testid="card" value={String(form.data.card_number)} onChange={(event) => form.set('card_number', event.target.value)} />
    </>
  );
}
Edit.layout = Layout;

function Tokens() {
  return (
    <>
      <Form route="tokens.store" remember={{ include: ['pin', 'plain'] as never }} data-testid="token-form">
        {(form) => (
          <>
            <input data-testid="token-name" {...(form as never as { field(name: string): object }).field('name')} defaultValue="" />
            <input data-testid="token-secret" name="secret" defaultValue="" />
            <input data-testid="token-pin" type="password" name="pin" defaultValue="" />
            <input data-testid="token-sms" autoComplete="one-time-code" name="plain" defaultValue="" />
            <input data-testid="token-recovery" name="recovery_code" defaultValue="" />
            <input data-testid="token-zip" name="zip_code" defaultValue="" />
            <input type="checkbox" data-testid="read" name="abilities[]" value="users:read" />
            <input type="checkbox" data-testid="write" name="abilities[]" value="users:write" />
            <small data-testid="token-error">{(form as never as { error(name: string): string | undefined }).error('name') ?? ''}</small>
            <button data-testid="token-submit">Create</button>
          </>
        )}
      </Form>
      <Form route="profile.update" data-testid="put-form">
        <input name="name" defaultValue="Ada" />
      </Form>
      <Form route="people" data-testid="search-form">
        <input data-testid="q" name="q" defaultValue="" />
      </Form>
    </>
  );
}
Tokens.layout = Layout;

const rendered: Record<string, unknown>[] = [];
function Show(props: { profile: { name: string } }) {
  rendered.push(props);
  return <h1 data-testid="profile">{props.profile.name}</h1>;
}
Show.layout = Layout;
Show.placeholder = ({ name }: { name: string }) => <h1 data-testid="placeholder">{name} …</h1>;

function People() {
  return <p data-testid="people">People</p>;
}
People.layout = Layout;

const pages: Record<string, PageComponent> = { Edit, Tokens, Show, People };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const routes: RouteManifest = {
  'profile.update': { method: 'put', path: '/users/1' },
  'profile.show': { method: 'get', path: '/users/2', view: 'app/Show' },
  'tokens.store': { method: 'post', path: '/tokens' },
  people: { method: 'get', path: '/people' },
};
const page = (name: string, url: string, props: Record<string, unknown> = {}, extra: Partial<PageObject> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null, ...extra });
const json = (body: object, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', [PAGE_HEADER]: 'true', ...headers } });

let server: (url: string, init: RequestInit) => Response | Promise<Response>;
let requests: { url: string; method: string; body: unknown }[];
let states: string[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/users/1');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  requests = [];
  states = [];
  rendered.length = 0;
  sessionStorage.clear();
  localStorage.clear();
  // The guard's question (the browser's own dialog): "leave".
  (window as { confirm?: () => boolean }).confirm = () => true;
  // Every history state the browser is handed — serialized, as it would be written to disk.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    vi.spyOn(history, method).mockImplementation((state, title, url) => {
      states.push(JSON.stringify(state));
      original(state, title, url);
    });
  }
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    requests.push({ url: String(input).replace(window.location.origin, ''), method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    return server(String(input).replace(window.location.origin, ''), init);
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

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const wait = (ms = 10) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const click = (testId: string) => act(async () => $(testId)!.click());
const type = (testId: string, value: string) =>
  act(async () => {
    const element = $(testId) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
const back = () =>
  act(async () => {
    history.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

/** Everything the browser keeps beyond this document's memory: history states, both storages, cookies. */
const persisted = () => [...states, JSON.stringify(history.state), JSON.stringify({ ...sessionStorage }), JSON.stringify({ ...localStorage }), document.cookie].join('\n');

describe('useRemember and useForm({ remember })', () => {
  it('survives Back/Forward in memory — and never lands in history.state, sessionStorage, localStorage or a cookie', async () => {
    server = () => json(page('People', '/people'));
    await mount(page('Edit', '/users/1', { name: 'Ada' }));
    await click('tab');
    await type('name', 'Ada MARKER');
    expect(navigator!.isGuarded()).toBe(true);
    // Leave (the guard asks — the browser's confirm says yes), then come back.
    await click('to-people');
    await wait();
    expect($('people')).not.toBeNull();
    await back();
    expect($('tab')!.textContent).toBe('activity');
    expect(($('name') as HTMLInputElement).value).toBe('Ada MARKER');
    // Still dirty after Back: the guard still holds the remembered input.
    expect(navigator!.isGuarded()).toBe(true);
    expect(persisted()).not.toContain('MARKER');
    expect(persisted()).not.toContain('activity');
  });

  it('a password is never remembered (nor a card number without `include`) — not even in memory', async () => {
    server = () => json(page('People', '/people'));
    await mount(page('Edit', '/users/1', { name: 'Ada' }));
    await type('password', 'hunter2-MARKER');
    await type('card', '4242-MARKER');
    await type('name', 'Ada L.');
    const kept = navigator!.use(remember).of(owner!.entry!);
    // What memory holds — inspected directly.
    expect(JSON.stringify(kept.keys().map((key) => kept.get(key)))).not.toContain('MARKER');
    await click('to-people');
    await wait();
    await back();
    expect(($('name') as HTMLInputElement).value).toBe('Ada L.');
    expect(($('password') as HTMLInputElement).value).toBe('');
    expect(($('card') as HTMLInputElement).value).toBe('');
  });

  it('forgotten when the document is left — signing out answers 409', async () => {
    server = (_url, init) => (init.method === 'POST' ? new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login', [RELOAD_HEADER]: 'history' } }) : json(page('People', '/people')));
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    await mount(page('Edit', '/users/1', { name: 'Ada' }));
    await type('name', 'Ada L.');
    const kept = navigator!.use(remember).of(owner!.entry!);
    expect(kept.size).toBeGreaterThan(0);
    await act(async () => void (await navigator!.visit('/logout', { method: 'post' })));
    expect(assign).toHaveBeenCalledWith('https://app.test/login');
    expect(kept.size).toBe(0);
  });
});

describe('<Form> — uncontrolled, typed by its route', () => {
  it('renders a real form for browsers without JavaScript: the route’s URL, POST, `_token` — `_method` for PUT', async () => {
    await mount(page('Tokens', '/tokens', {}, { csrf: 'the-token' }));
    const tokens = $('token-form') as HTMLFormElement;
    expect([tokens.getAttribute('action'), tokens.getAttribute('method')]).toEqual(['/tokens', 'post']);
    expect((tokens.querySelector('[name="_token"]') as HTMLInputElement).value).toBe('the-token');
    expect(tokens.querySelector('[name="_method"]')).toBeNull();
    const put = $('put-form') as HTMLFormElement;
    expect((put.querySelector('[name="_method"]') as HTMLInputElement).value).toBe('PUT');
    expect(($('search-form') as HTMLFormElement).getAttribute('method')).toBe('get');
    expect($('search-form')!.querySelector('[name="_token"]')).toBeNull();
  });

  it('sends the fields in the body as the server parses them — never in the URL — and shows the errors by field', async () => {
    let open!: (response: Response) => void;
    server = () => new Promise((resolve) => (open = resolve));
    await mount(page('Tokens', '/tokens', {}, { csrf: 'the-token' }));
    await type('token-name', 'CI');
    await click('read');
    await act(async () => ($('token-form') as HTMLFormElement).requestSubmit());
    expect($('token-form')!.hasAttribute('data-pending')).toBe(true);
    expect(requests).toEqual([{ url: '/tokens', method: 'POST', body: { name: 'CI', secret: '', pin: '', plain: '', recovery_code: '', zip_code: '', abilities: ['users:read'] } }]);
    await act(async () => open(json(page('Tokens', '/tokens', { errors: { name: ['Taken.'] } }))));
    await wait();
    expect($('token-error')!.textContent).toBe('Taken.');
    expect($('token-name')!.getAttribute('aria-invalid')).toBe('true');
    expect($('token-form')!.hasAttribute('data-pending')).toBe(false);
  });

  it('a GET form writes its fields into the query — its route’s query schema', async () => {
    server = () => json(page('People', '/people?q=ada'));
    await mount(page('Tokens', '/tokens'));
    await type('q', 'ada');
    await act(async () => ($('search-form') as HTMLFormElement).requestSubmit());
    await wait();
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(['GET /people?q=ada']);
  });

  it('remembers its input across Back/Forward — but not a field named like a secret', async () => {
    server = () => json(page('People', '/people'));
    await mount(page('Tokens', '/tokens'));
    await type('token-name', 'Deploy');
    await type('token-secret', 's3cret');
    await type('token-pin', '1234');
    // A show-password toggle turns the field into plain text: it stays one that is never remembered.
    ($('token-pin') as HTMLInputElement).type = 'text';
    await type('token-pin', '12345');
    await type('token-sms', '987654');
    await type('token-recovery', 'abcd-efgh');
    await type('token-zip', '10115');
    await click('write');
    await click('to-people');
    await wait();
    await back();
    expect(($('token-name') as HTMLInputElement).value).toBe('Deploy');
    expect(($('write') as HTMLInputElement).checked).toBe(true);
    expect(($('read') as HTMLInputElement).checked).toBe(false);
    expect(($('token-secret') as HTMLInputElement).value).toBe('');
    // By what the control is, not by its name — and `include` does not change that.
    expect(($('token-pin') as HTMLInputElement).value).toBe('');
    expect(($('token-sms') as HTMLInputElement).value).toBe('');
    expect(($('token-recovery') as HTMLInputElement).value).toBe('');
    expect(($('token-zip') as HTMLInputElement).value).toBe('10115');
    expect($('token-form')!.hasAttribute('data-dirty')).toBe(true);
  });
});

describe('instant visits', () => {
  it('shows the view’s placeholder with what the link gave it — the view itself only ever with its page', async () => {
    let open!: (response: Response) => void;
    server = () => new Promise((resolve) => (open = resolve));
    history.replaceState(null, '', '/people');
    await mount(page('People', '/people'));
    await click('to-grace');
    await wait();
    expect($('placeholder')!.textContent).toBe('Grace …');
    expect($('people')).toBeNull();
    expect(location.pathname).toBe('/people');
    expect(rendered).toEqual([]);
    await act(async () => open(json(page('Show', '/users/2', { profile: { name: 'Grace Hopper' } }))));
    await wait();
    expect($('profile')!.textContent).toBe('Grace Hopper');
    expect($('placeholder')).toBeNull();
    expect(location.pathname).toBe('/users/2');
    expect(rendered.every((props) => typeof (props.profile as { name?: unknown } | undefined)?.name === 'string')).toBe(true);
  });
});

describe('a new build', () => {
  it('postponed by the app (`version` prevented): `useNewVersion()` says where it waits — no reload', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    server = () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/people', [RELOAD_HEADER]: 'version' } });
    await mount(page('Edit', '/users/1', { name: 'Ada' }));
    const stop = navigator!.on('version', (event) => event.preventDefault());
    await act(async () => void (await navigator!.reload({ only: ['name'], async: true })));
    stop();
    expect($('new-version')!.textContent).toBe('https://app.test/people');
    expect(assign).not.toHaveBeenCalled();
  });
});
