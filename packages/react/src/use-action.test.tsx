// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1" }
import { ACTION_HEADER, ACTION_REDIRECT_HEADER, PAGE_HEADER, PARTIAL_DATA_HEADER, type PageObject, type RouteManifest } from '@marmeon/http/page';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, useRouter } from './app.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { useAction, usePendingSubmissions } from './use-action.ts';
import { Link } from './link.tsx';
import { loadHistoryFallback } from '@marmeon/http/client';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Link = { id: number; label: string };

function Profile({ links, activity }: { links: Link[]; activity: string }) {
  const router = useRouter();
  const remove = useAction('links.destroy');
  const add = useAction('links.store');
  const adding = usePendingSubmissions('links.store');
  const [label, setLabel] = useState('');
  return (
    <main>
      <ul data-testid="links">
        {links.map((link) => (
          <li key={link.id}>
            {link.label}
            <button
              type="button"
              data-testid={`remove-${link.id}`}
              onClick={() =>
                void remove.submit({
                  params: { link: link.id },
                  optimistic: router.optimistic((props) => ({ links: (props.links as Link[]).filter((other) => other.id !== link.id) })),
                })
              }
            >
              x
            </button>
          </li>
        ))}
        {adding.map((call) => (
          <li key={`ghost-${call.id}`} data-testid="ghost">
            {(call.input as { label: string }).label}
          </li>
        ))}
      </ul>
      <input data-testid="label" value={label} onChange={(event) => setLabel(event.target.value)} />
      <button type="button" data-testid="add" onClick={() => void add.submit({ data: { label }, reload: router.reloading({ only: ['links'] }) })}>
        add
      </button>
      <p data-testid="pending">{String(remove.pending)}</p>
      <p data-testid="errors">{JSON.stringify(add.errors)}</p>
      <p data-testid="exception">{remove.exception?.type === 'server' ? remove.exception.status : ''}</p>
      <p data-testid="activity">{activity}</p>
      <Link href="/people" data-testid="to-people">
        People
      </Link>
    </main>
  );
}
Profile.revalidateOnBack = ['activity'];

type Feed = { data: { id: number }[]; meta: { nextCursor: string | null } };

/** A merge()d list with "load more" — and a delete that reloads it (the reload replaces it, the row stays gone). */
function Inbox({ inbox }: { inbox: Feed }) {
  const router = useRouter();
  const destroy = useAction('inbox.destroy');
  const keep = useAction('inbox.destroy');
  return (
    <main>
      <ul data-testid="inbox">
        {inbox.data.map((row) => (
          <li key={row.id}>
            {row.id}
            <button type="button" data-testid={`delete-${row.id}`} onClick={() => void destroy.submit({ params: { id: row.id }, reload: router.reloading({ only: ['inbox'] }) })}>
              x
            </button>
            <button type="button" data-testid={`delete-appending-${row.id}`} onClick={() => void keep.submit({ params: { id: row.id }, reload: router.reloading({ only: ['inbox'], reset: [] }) })}>
              x
            </button>
          </li>
        ))}
      </ul>
      {inbox.meta.nextCursor && (
        <button type="button" data-testid="more" onClick={() => void router.reload({ data: { cursor: inbox.meta.nextCursor }, only: ['inbox'], preserveUrl: true })}>
          more
        </button>
      )}
    </main>
  );
}

function People() {
  return <p data-testid="people">People</p>;
}

const pages: Record<string, PageComponent> = { Profile, People, Inbox };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const routes: RouteManifest = {
  'links.destroy': { method: 'delete', path: '/links/:link' },
  'links.store': { method: 'post', path: '/links' },
  'inbox.destroy': { method: 'delete', path: '/inbox/:id' },
};
const page = (name: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null });
const profile = (labels: string[], activity = 'old') => page('Profile', '/users/1', { links: labels.map((label, index) => ({ id: index + 1, label })), activity });
const respond = (body: object, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let server: (url: string, init: RequestInit) => Response | Promise<Response>;
let requests: { url: string; method: string; headers: Record<string, string> }[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/users/1');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  requests = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    requests.push({ url: String(input), method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) } });
    return server(String(input), init);
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

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)!;
const wait = (ms = 10) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const click = (testId: string) => act(async () => ($(testId) as HTMLElement).click());
const labels = () => [...$('links').querySelectorAll('li')].map((item) => item.firstChild?.textContent);

function gate() {
  let open!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => (open = resolve));
  return { promise, open };
}

describe('useAction', () => {
  it('removes optimistically by the route name — and rolls back on a 404, showing why', async () => {
    const answer = gate();
    server = () => answer.promise;
    await mount(profile(['Notes', 'Blog']));
    await click('remove-1');
    expect(labels()).toEqual(['Blog']);
    expect($('pending').textContent).toBe('true');
    expect(requests).toEqual([{ url: '/links/1', method: 'DELETE', headers: expect.objectContaining({ [ACTION_HEADER]: 'true' }) }]);
    expect(location.pathname).toBe('/users/1');

    await act(async () => answer.open(respond({ message: 'Not found.' }, 404)));
    await wait();
    expect(labels()).toEqual(['Notes', 'Blog']);
    expect($('pending').textContent).toBe('false');
    expect($('exception').textContent).toBe('404');
  });

  it('shows a ghost row while adding — until the reloaded list has the real one; a 422 brings the errors by field', async () => {
    const post = gate();
    const reload = gate();
    server = (_url, init) => (init.method === 'POST' ? post.promise : reload.promise);
    await mount(profile(['Notes']));
    await act(async () => {
      const input = $('label') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Blog');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('add');
    expect(labels()).toEqual(['Notes', 'Blog']);
    expect($('ghost').textContent).toBe('Blog');

    await act(async () => post.open(new Response(null, { status: 204, headers: { [ACTION_REDIRECT_HEADER]: '/users/1' } })));
    await wait();
    // Still the ghost: the reload of `links` has not landed.
    expect(container.querySelectorAll('[data-testid="ghost"]')).toHaveLength(1);
    expect(requests.at(-1)!.headers).toMatchObject({ [PAGE_HEADER]: 'true', [PARTIAL_DATA_HEADER]: 'links' });
    await act(async () => reload.open(new Response(JSON.stringify({ ...profile(['Notes', 'Blog']), props: { links: [{ id: 1, label: 'Notes' }, { id: 2, label: 'Blog' }] } }), { headers: { [PAGE_HEADER]: 'true' } })));
    await wait();
    expect(labels()).toEqual(['Notes', 'Blog']);
    expect(container.querySelectorAll('[data-testid="ghost"]')).toHaveLength(0);

    server = () => respond({ message: 'The given data was invalid.', errors: { label: ['Taken.', 'Too short.'] } }, 422);
    await click('add');
    await wait();
    expect($('errors').textContent).toBe('{"label":"Taken."}');
    expect(container.querySelectorAll('[data-testid="ghost"]')).toHaveLength(0);
  });

  it('revalidateOnBack: Back shows the profile from memory at once, then reloads only `activity` — the view says so', async () => {
    server = (url, init) => {
      if (url.startsWith('/people')) return new Response(JSON.stringify(page('People', '/people')), { headers: { [PAGE_HEADER]: 'true' } });
      const only = (init.headers as Record<string, string>)[PARTIAL_DATA_HEADER];
      return new Response(JSON.stringify({ ...profile(['Notes']), props: only === 'activity' ? { activity: 'fresh' } : profile(['Notes']).props }), { headers: { [PAGE_HEADER]: 'true' } });
    };
    await mount(profile(['Notes']));
    await click('to-people');
    await wait();
    expect($('people').textContent).toBe('People');
    const before = requests.length;
    await act(async () => history.back());
    await wait(30);
    expect(requests.slice(before)).toEqual([expect.objectContaining({ url: '/users/1', method: 'GET', headers: expect.objectContaining({ [PARTIAL_DATA_HEADER]: 'activity' }) })]);
    expect($('activity').textContent).toBe('fresh');
    expect(labels()).toEqual(['Notes']);
  });

  it('a row deleted from a merge()d list that loaded more stays gone: the action’s reload replaces the list — load more appends again', async () => {
    const feed = (url: string, ids: number[], next: string | null): PageObject => ({
      ...page('Inbox', url, { inbox: { data: ids.map((id) => ({ id })), meta: { nextCursor: next } } }),
      mergeProps: ['inbox'],
      matchPropsOn: ['inbox.data.id'],
    });
    let stored = [1, 2, 3, 4, 5];
    server = (url, init) => {
      if (init.method === 'DELETE') {
        stored = stored.filter((id) => id !== Number(url.split('/').at(-1)));
        return respond({ deleted: true });
      }
      const cursor = Number(new URL(url, 'https://app.test').searchParams.get('cursor') ?? 0);
      const ids = stored.filter((id) => id > cursor).slice(0, 2);
      const next = stored.some((id) => id > (ids.at(-1) ?? Infinity)) ? String(ids.at(-1)) : null;
      return new Response(JSON.stringify(feed(url, ids, next)), { headers: { [PAGE_HEADER]: 'true' } });
    };
    history.replaceState(null, '', '/inbox');
    await mount(feed('/inbox', [1, 2], '2'));
    const shown = () => [...$('inbox').querySelectorAll('li')].map((item) => Number(item.firstChild?.textContent));
    await click('more');
    await wait();
    expect(shown()).toEqual([1, 2, 3, 4]);

    await click('delete-3');
    await wait(30);
    expect(requests.at(-1)!.headers).toMatchObject({ [PARTIAL_DATA_HEADER]: 'inbox' });
    // The first page again, without the deleted row — not the old list with the first page merged over it (3 came back then).
    expect(shown(), 'the deleted row came back').toEqual([1, 2]);

    await click('more');
    await wait();
    expect(shown()).toEqual([1, 2, 4, 5]);
    expect(location.pathname + location.search).toBe('/inbox');

    // reset: [] — the way back: merged into what is shown (the deleted row stays until a reload starts the list over).
    await click('delete-appending-4');
    await wait(30);
    expect(shown()).toEqual([1, 2, 4, 5]);
  });
});
