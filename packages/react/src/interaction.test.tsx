// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1/edit" }
import type { FlashMessage, RouteManifest } from '@marmeon/http/page';
import { PAGE_HEADER, type PageObject } from '@marmeon/http/protocol';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp } from './app.tsx';
import { ConfirmDialog } from './confirm.tsx';
import { useFlash } from './flash.ts';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { usePending } from './state.ts';
import { useAction } from './use-action.ts';
import { useForm } from './use-form.ts';
import { loadHistoryFallback } from '@marmeon/http/client';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Flash, state attributes, the navigation guard and confirm in React. */

const toasts: string[] = [];

function Layout({ children }: { children: React.ReactNode }) {
  useFlash('toast', (data) => toasts.push((data as { message: string }).message));
  const saving = usePending('profile.update');
  return (
    <>
      <nav>
        <Link route="profile.edit" data-testid="nav-edit">
          Edit
        </Link>
        <Link href="/people" data-testid="nav-people" activeMatch="profile.*">
          People
        </Link>
        <Link href="/people" data-testid="nav-people-exact">
          People exactly
        </Link>
      </nav>
      <p data-testid="saving">{String(saving)}</p>
      {children}
    </>
  );
}

function Edit({ name }: { name: string }) {
  const form = useForm('profile.update', {}, { name }, { guard: 'Unsaved changes.' });
  const remove = useAction('project.destroy');
  const [typed, setTyped] = useState('');
  return (
    <form
      data-testid="form"
      data-dirty={form.isDirty() || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
    >
      <input data-testid="name" data-dirty={form.isDirty('name') || undefined} value={String(form.data.name)} onChange={(event) => form.set('name', event.target.value)} />
      <button data-testid="save">Save</button>
      <button type="button" data-testid="delete" onClick={() => void remove.submit({ confirm: { message: 'Delete the project?', prompt: 'DELETE' } }).then((result) => setTyped(result.kind))}>
        Delete
      </button>
      <p data-testid="outcome">{typed}</p>
    </form>
  );
}
Edit.layout = Layout;

// A form whose callbacks reset fields after the submit — the password back to empty, the rest as sent.
function Secret({ name }: { name: string }) {
  const form = useForm('profile.update', {}, { name, password: '' }, { guard: 'Unsaved changes.' });
  return (
    <form
      data-testid="form"
      data-dirty={form.isDirty() || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit({ onFinish: () => form.reset('password') });
      }}
    >
      <input data-testid="name" value={String(form.data.name)} onChange={(event) => form.set('name', event.target.value)} />
      <input data-testid="password" value={String(form.data.password)} onChange={(event) => form.set('password', event.target.value)} />
      <button data-testid="save">Save</button>
      <button type="button" data-testid="undo" onClick={() => form.reset()}>
        Undo
      </button>
    </form>
  );
}
Secret.layout = Layout;

function People() {
  return <p data-testid="people">People</p>;
}
People.layout = Layout;

const pages: Record<string, PageComponent> = { Edit, Secret, People };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const routes: RouteManifest = {
  'profile.edit': { method: 'get', path: '/users/1/edit' },
  'profile.update': { method: 'put', path: '/users/1' },
  people: { method: 'get', path: '/people' },
  'project.destroy': { method: 'delete', path: '/projects/1' },
};
const page = (name: string, url: string, props: Record<string, unknown> = {}, extra: Partial<PageObject> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null, ...extra });
const json = (body: object, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', [PAGE_HEADER]: 'true', ...headers } });
const toast = (id: string, message: string) => ({ id, key: 'toast', data: { kind: 'success', message } }) as unknown as FlashMessage;

let server: (url: string, init: RequestInit) => Response | Promise<Response>;
let requests: string[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/users/1/edit');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  requests = [];
  toasts.length = 0;
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    requests.push(`${init.method ?? 'GET'} ${String(input).replace(window.location.origin, '')}`);
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
  await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} confirm={ConfirmDialog} />));
}

const $ = (selector: string) => container.querySelector(selector.startsWith('[') || selector.includes(' ') ? selector : `[data-testid="${selector}"]`)! as HTMLElement;
const wait = (ms = 10) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const click = (testId: string) => act(async () => $(testId).click());
const type = (element: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
const dialog = () => document.querySelector('[data-marmeon-confirm]') as HTMLDialogElement | null;
const answer = (label: 'confirm' | 'cancel') => act(async () => (dialog()!.querySelector(label === 'confirm' ? '[data-confirm]' : 'button[type="button"]') as HTMLElement).click());

describe('toasts: useFlash', () => {
  it('fires the first page’s message once — and a visit’s after its page is on screen', async () => {
    server = () => json(page('People', '/people', {}, { flash: [toast('b', 'Moved.')] }));
    await mount(page('Edit', '/users/1/edit', { name: 'Ada' }, { flash: [toast('a', 'Saved.')] }));
    expect(toasts).toEqual(['Saved.']);
    await click('nav-people');
    await wait();
    expect($('people')).not.toBeNull();
    expect(toasts).toEqual(['Saved.', 'Moved.']);
  });
});

describe('state attributes', () => {
  it('marks the link to the page on screen — exactly, or by `activeMatch` — and `data-pending` while its visit runs', async () => {
    let open!: (response: Response) => void;
    server = () => new Promise((resolve) => (open = resolve));
    await mount(page('Edit', '/users/1/edit', { name: 'Ada' }, { route: 'profile.edit' }));
    expect($('nav-edit').getAttribute('aria-current')).toBe('page');
    expect($('nav-edit').hasAttribute('data-current')).toBe(true);
    // Another URL, but the route matches `profile.*`.
    expect($('nav-people').getAttribute('aria-current')).toBe('page');
    expect($('nav-people-exact').hasAttribute('aria-current')).toBe(false);

    await click('nav-people-exact');
    expect($('nav-people-exact').hasAttribute('data-pending')).toBe(true);
    expect($('nav-people').hasAttribute('data-pending')).toBe(true); // the same URL
    expect($('nav-edit').hasAttribute('data-pending')).toBe(false);
    expect(document.documentElement.getAttribute('aria-busy')).toBe('true');
    await act(async () => open(json(page('People', '/people', {}, { route: 'people' }))));
    await wait();
    expect($('nav-people-exact').getAttribute('aria-current')).toBe('page');
    expect($('nav-people-exact').hasAttribute('data-pending')).toBe(false);
    expect(document.documentElement.hasAttribute('aria-busy')).toBe(false);
  });

  it('dirty paths per field, `data-dirty` — and `usePending(name)` while the form is sent', async () => {
    let open!: (response: Response) => void;
    server = () => new Promise((resolve) => (open = resolve));
    await mount(page('Edit', '/users/1/edit', { name: 'Ada' }));
    expect($('form').hasAttribute('data-dirty')).toBe(false);
    await type($('name') as HTMLInputElement, 'Ada King');
    expect($('form').hasAttribute('data-dirty')).toBe(true);
    expect($('name').hasAttribute('data-dirty')).toBe(true);
    await click('save');
    expect($('saving').textContent).toBe('true');
    await act(async () => open(json(page('Edit', '/users/1/edit', { name: 'Ada King' }))));
    await wait();
    expect($('saving').textContent).toBe('false');
    // Saved: where the form starts over — not dirty.
    expect($('form').hasAttribute('data-dirty')).toBe(false);
  });
});

describe('reset() in a submit callback', () => {
  it('resets to the defaults before the submit, and the saved form is not dirty — no question on leaving', async () => {
    server = (url) => json(url.startsWith('/people') ? page('People', '/people') : page('Secret', '/users/1/edit', { name: 'Ada King' }));
    await mount(page('Secret', '/users/1/edit', { name: 'Ada' }));
    await type($('name') as HTMLInputElement, 'Ada King');
    await type($('password') as HTMLInputElement, 'secret password');
    await click('save');
    await wait();
    expect(requests).toEqual(['PUT /users/1']);
    // The password is empty again, the name stays as sent — and that is where the form starts over.
    expect(($('password') as HTMLInputElement).value).toBe('');
    expect(($('name') as HTMLInputElement).value).toBe('Ada King');
    expect($('form').hasAttribute('data-dirty')).toBe(false);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    // A later reset() goes back to the saved state, not to the first one.
    await type($('name') as HTMLInputElement, 'Ada Lovelace');
    await click('undo');
    expect(($('name') as HTMLInputElement).value).toBe('Ada King');
    expect($('form').hasAttribute('data-dirty')).toBe(false);
    await click('nav-people-exact');
    await wait();
    expect(dialog()).toBeNull();
    expect($('people')).not.toBeNull();
  });

  it('after a failed submit the reset field is back, the rest stays dirty', async () => {
    server = () => json(page('Secret', '/users/1/edit', { name: 'Ada', errors: { name: 'Taken.' } }));
    await mount(page('Secret', '/users/1/edit', { name: 'Ada' }));
    await type($('name') as HTMLInputElement, 'Ada King');
    await type($('password') as HTMLInputElement, 'secret password');
    await click('save');
    await wait();
    expect(($('password') as HTMLInputElement).value).toBe('');
    expect(($('name') as HTMLInputElement).value).toBe('Ada King');
    expect($('form').hasAttribute('data-dirty')).toBe(true);
  });
});

describe('the navigation guard', () => {
  it('a dirty form asks before a link leaves — Stay sends nothing, Leave goes; after saving it asks no more', async () => {
    server = (url) => json(url.startsWith('/people') ? page('People', '/people') : page('Edit', '/users/1/edit', { name: 'Ada King' }));
    await mount(page('Edit', '/users/1/edit', { name: 'Ada' }));
    await type($('name') as HTMLInputElement, 'Ada King');
    await click('nav-people-exact');
    expect(dialog()?.getAttribute('data-kind')).toBe('leave');
    expect(dialog()!.textContent).toContain('Unsaved changes.');
    expect(document.activeElement?.textContent).toBe('Stay'); // the safe choice first
    await answer('cancel');
    expect(dialog()).toBeNull();
    expect(requests).toEqual([]);

    // Its own submit passes its guard, and afterwards the form is not dirty: the link goes without asking.
    await click('save');
    await wait();
    expect(requests).toEqual(['PUT /users/1']);
    await click('nav-people-exact');
    await wait();
    expect(dialog()).toBeNull();
    expect($('people')).not.toBeNull();
  });

  it('Leave goes, and closing the tab while dirty gets the browser’s question', async () => {
    server = () => json(page('People', '/people'));
    await mount(page('Edit', '/users/1/edit', { name: 'Ada' }));
    await type($('name') as HTMLInputElement, 'Ada King');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await click('nav-people-exact');
    await answer('confirm');
    await wait();
    expect($('people')).not.toBeNull();
  });
});

describe('confirm', () => {
  it('type-to-confirm — the yes stays off for a wrong text, a submitted wrong text sends nothing; the exact text sends', async () => {
    server = () => new Response(null, { status: 204, headers: { 'x-marmeon-redirect': '/projects' } });
    await mount(page('Edit', '/users/1/edit', { name: 'Ada' }));
    await click('delete');
    const field = dialog()!.querySelector('input')!;
    expect(document.activeElement).toBe(field);
    expect(dialog()!.getAttribute('role')).toBe('alertdialog');
    await type(field, 'DELET');
    expect((dialog()!.querySelector('[data-confirm]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => dialog()!.querySelector('form')!.requestSubmit());
    expect(dialog()).not.toBeNull(); // no answer yet
    await answer('cancel');
    await wait();
    expect($('outcome').textContent).toBe('cancelled');
    expect(requests).toEqual([]);

    await click('delete');
    await type(dialog()!.querySelector('input')!, 'DELETE');
    await answer('confirm');
    await wait();
    expect(requests).toEqual(['DELETE /projects/1']);
    expect($('outcome').textContent).toBe('redirect');
  });
});
