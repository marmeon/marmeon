// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1/edit" }
import type { FlashMessage, RouteManifest } from '@marmeon/http/page';
import { PAGE_HEADER, type PageObject, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { act, startTransition, StrictMode, use, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp } from './app.tsx';
import { until } from './test-helpers/settle.ts';
import { ConfirmDialog } from './confirm.tsx';
import { useFlash } from './flash.ts';
import { Link } from './link.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { usePending } from './state.ts';
import { useAction } from './use-action.ts';
import { useForm } from './use-form.ts';
import { loadHistoryFallback } from '@marmeon/http/client/adapter';

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
  const form = useForm('profile.update', { name }, { guard: 'Unsaved changes.' });
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
  const form = useForm('profile.update', { name, password: '' }, { guard: 'Unsaved changes.' });
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

// Buttons that set and submit in one handler: the request has to carry what the handler set, not the last render's data.
const sent: Record<string, unknown>[] = [];
// A transition that renders `status` waits here until the test lets it through.
let slowRender: Promise<void> | undefined;
function SlowStatus({ status }: { status: string }) {
  if (status === 'queued' && slowRender) use(slowRender);
  return <p data-testid="status">{status}</p>;
}
function Publish() {
  const form = useForm('profile.update', { title: 'Draft', status: 'draft', tags: [] as string[], meta: { pinned: false } }, { guard: false });
  return (
    <section>
      <button type="button" data-testid="publish" onClick={() => { form.set('status', 'published'); void form.submit(); }}>
        Publish
      </button>
      <button
        type="button"
        data-testid="several"
        onClick={() => {
          form.set('title', 'Final');
          form.set('status', 'published');
          form.set('tags', ['a', 'b']);
          void form.submit();
        }}
      >
        Several
      </button>
      <button type="button" data-testid="nested" onClick={() => { form.set('meta', { pinned: true }); form.set('tags', ['x']); void form.submit(); }}>
        Nested
      </button>
      <button type="button" data-testid="set-data" onClick={() => { form.setData({ ...form.data, title: 'Whole' }); void form.submit(); }}>
        Set data
      </button>
      <button type="button" data-testid="set-twice" onClick={() => { form.set('title', 'Once'); void form.submit(); form.set('title', 'Twice'); }}>
        Twice
      </button>
      <button type="button" data-testid="reset-one" onClick={() => { form.set('title', 'Changed'); form.set('status', 'published'); form.reset('title'); void form.submit(); }}>
        Reset one
      </button>
      <button type="button" data-testid="reset-all" onClick={() => { form.set('title', 'Changed'); form.reset(); void form.submit(); }}>
        Reset all
      </button>
      <button type="button" data-testid="lane-a" onClick={() => { form.set('title', 'A'); startTransition(() => form.set('status', 'B')); }}>
        Lane A
      </button>
      <button type="button" data-testid="lane-b" onClick={() => { form.set('tags', ['c']); void form.submit(); }}>
        Lane B
      </button>
      <button type="button" data-testid="set-only" onClick={() => form.set('title', 'Typed')}>
        Set only
      </button>
      <button
        type="button"
        data-testid="transition"
        onClick={() => {
          startTransition(() => form.set('title', 'Later'));
          void form.submit();
        }}
      >
        Transition
      </button>
      <button type="button" data-testid="send-transition" onClick={() => { startTransition(() => form.set('status', 'queued')); void form.submit(); }}>
        Send transition
      </button>
      <p data-testid="dirty">{String(form.isDirty())}</p>
      <p data-testid="title">{String(form.data.title)}</p>
      <SlowStatus status={String(form.data.status)} />
      <p data-testid="title-dirty">{String(form.isDirty('title'))}</p>
      <p data-testid="processing">{String(form.processing)}</p>
    </section>
  );
}
Publish.layout = Layout;

function People() {
  return <p data-testid="people">People</p>;
}
People.layout = Layout;

const pages: Record<string, PageComponent> = { Edit, Secret, Publish, People };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const routes: RouteManifest = {
  'profile.edit': { method: 'get', path: '/users/1/edit' },
  'profile.update': { method: 'put', path: '/users/1' },
  people: { method: 'get', path: '/people' },
  'project.destroy': { method: 'delete', path: '/projects/1' },
};
const page = (name: string, url: string, props: Record<string, unknown> = {}, extra: Partial<PageObject> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null, ...extra });
const json = (body: object, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', [PAGE_HEADER]: PROTOCOL_VERSION, ...headers } });
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

async function mount(initial: PageObject, strict = false) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  const app = <MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} confirm={ConfirmDialog} />;
  await act(async () => root.render(strict ? <StrictMode>{app}</StrictMode> : app));
}

const $ = (selector: string) => container.querySelector(selector.startsWith('[') || selector.includes(' ') ? selector : `[data-testid="${selector}"]`)! as HTMLElement;
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
    await until(() => expect(toasts).toEqual(['Saved.', 'Moved.']));
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
    await until(() => expect($('nav-people-exact').getAttribute('aria-current')).toBe('page'));
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
    await until(() => expect($('saving').textContent).toBe('false'));
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
    await until(() => expect(($('password') as HTMLInputElement).value).toBe('')); // the response is handled: onFinish has reset it
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
    await until(() => expect($('people')).not.toBeNull());
    expect(dialog()).toBeNull();
  });

  it('after a failed submit the reset field is back, the rest stays dirty', async () => {
    server = () => json(page('Secret', '/users/1/edit', { name: 'Ada', errors: { name: 'Taken.' } }));
    await mount(page('Secret', '/users/1/edit', { name: 'Ada' }));
    await type($('name') as HTMLInputElement, 'Ada King');
    await type($('password') as HTMLInputElement, 'secret password');
    await click('save');
    await until(() => expect(($('password') as HTMLInputElement).value).toBe(''));
    expect(($('password') as HTMLInputElement).value).toBe('');
    expect(($('name') as HTMLInputElement).value).toBe('Ada King');
    expect($('form').hasAttribute('data-dirty')).toBe(true);
  });
});

describe('set() and submit() in one handler', () => {
  const lastBody = () => JSON.parse(String(sent.at(-1)));
  beforeEach(() => {
    sent.length = 0;
    server = (url, init) => {
      if (init.body !== undefined) sent.push(init.body as never);
      return json(page('Publish', '/users/1/edit'));
    };
  });
  const open = () => mount(page('Publish', '/users/1/edit'), true);

  it('sends the value that set() wrote, once', async () => {
    await open();
    await click('publish');
    await until(() => expect(requests).toEqual(['PUT /users/1']));
    expect(lastBody()).toMatchObject({ title: 'Draft', status: 'published' });
    expect($('status').textContent).toBe('published');
  });

  it('sends several set() calls, an array and a nested object', async () => {
    await open();
    await click('several');
    await until(() => expect(requests.length).toBe(1));
    expect(lastBody()).toMatchObject({ title: 'Final', status: 'published', tags: ['a', 'b'] });
    await click('nested');
    await until(() => expect(requests.length).toBe(2));
    expect(lastBody()).toMatchObject({ meta: { pinned: true }, tags: ['x'] });
  });

  it('sends the data of setData()', async () => {
    await open();
    await click('set-data');
    await until(() => expect(requests.length).toBe(1));
    expect(lastBody().title).toBe('Whole');
  });

  it('sends the default after reset(), the rest as set', async () => {
    await open();
    await click('reset-one');
    await until(() => expect(requests.length).toBe(1));
    expect(lastBody()).toMatchObject({ title: 'Draft', status: 'published' });
  });

  it('sends the defaults after reset() of the whole form', async () => {
    await open();
    await click('reset-all');
    await until(() => expect(requests.length).toBe(1));
    expect(lastBody()).toMatchObject({ title: 'Draft', status: 'draft' });
  });

  it('a set() after the submit() in the same handler is not part of that request', async () => {
    await open();
    await click('set-twice');
    await until(() => expect(requests.length).toBe(1));
    expect(lastBody().title).toBe('Once');
  });

  it('sends a value set in a transition', async () => {
    await open();
    await click('transition');
    await until(() => expect(requests.length).toBe(1));
    expect(lastBody().title).toBe('Later');
  });

  it('keeps isDirty() on the rendered data', async () => {
    server = () => new Promise<Response>(() => {});
    await open();
    expect($('title-dirty').textContent).toBe('false');
    await click('set-only');
    expect($('title-dirty').textContent).toBe('true');
    await click('reset-one');
    expect($('processing').textContent).toBe('true');
    expect($('title-dirty').textContent).toBe('false');
  });

  it('a set() while a submit is under way is sent by the next submit', async () => {
    const releases: (() => void)[] = [];
    server = (url, init) => {
      sent.push(init.body as never);
      return new Promise<Response>((resolve) => releases.push(() => resolve(json(page('Publish', '/users/1/edit')))));
    };
    await open();
    await click('publish');
    expect($('processing').textContent).toBe('true');
    expect(lastBody()).toMatchObject({ title: 'Draft', status: 'published' });
    await click('set-only');
    await click('lane-b');
    expect(requests.length).toBe(2);
    expect(lastBody()).toMatchObject({ title: 'Typed', status: 'published', tags: ['c'] });
    await act(async () => releases.forEach((release) => release()));
    await until(() => expect($('processing').textContent).toBe('false'));
  });

  it('keeps a set() made in a transition when an urgent update renders first', async () => {
    await open();
    // Outside act(), the urgent render of the first click commits while the transition is still waiting for its turn.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      $('lane-a').click();
      await Promise.resolve();
      $('lane-b').click();
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true;
    }
    await until(() => expect(requests.length).toBe(1));
    expect(lastBody()).toMatchObject({ title: 'A', status: 'B', tags: ['c'] });
  });

  it('does not render a field a pending transition set in the commit of an urgent set()', async () => {
    await open();
    const before = $('status').textContent;
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      $('lane-a').click();
      await Promise.resolve();
      $('set-only').click();
      await Promise.resolve();
      // The urgent commit is on screen; the transition has not rendered yet.
      expect($('title').textContent).toBe('Typed');
      expect($('status').textContent).toBe(before);
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true;
    }
    await until(() => expect($('status').textContent).toBe('B'));
  });
});

describe('what a successful submit saves', () => {
  const lastBody = () => JSON.parse(String(sent.at(-1)));
  const releases: (() => void)[] = [];
  beforeEach(() => {
    sent.length = 0;
    releases.length = 0;
    server = (url, init) => {
      if (init.body !== undefined) sent.push(init.body as never);
      return new Promise<Response>((resolve) => releases.push(() => resolve(json(page('Edit', '/users/1/edit', { name: 'Ada King' })))));
    };
  });

  it('an edit typed while the request is under way was not sent: it stays dirty, and the guard still asks', async () => {
    await mount(page('Edit', '/users/1/edit', { name: 'Ada' }));
    await type($('name') as HTMLInputElement, 'Ada King');
    await click('save');
    expect($('saving').textContent).toBe('true');
    await type($('name') as HTMLInputElement, 'Ada Kingsley');
    await act(async () => releases.forEach((release) => release()));
    await until(() => expect($('saving').textContent).toBe('false'));
    expect(lastBody()).toEqual({ name: 'Ada King' });
    expect($('form').hasAttribute('data-dirty')).toBe(true);
    expect($('name').hasAttribute('data-dirty')).toBe(true);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await click('nav-people-exact');
    expect(dialog()?.getAttribute('data-kind')).toBe('leave');
    await answer('cancel');
    // Typing the sent value back is clean again: the baseline is what was sent.
    await type($('name') as HTMLInputElement, 'Ada King');
    expect($('form').hasAttribute('data-dirty')).toBe(false);
  });

  it('a plain submit with no further edits is clean', async () => {
    await mount(page('Edit', '/users/1/edit', { name: 'Ada' }));
    await type($('name') as HTMLInputElement, 'Ada King');
    await click('save');
    await act(async () => releases.forEach((release) => release()));
    await until(() => expect($('saving').textContent).toBe('false'));
    expect($('form').hasAttribute('data-dirty')).toBe(false);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it('a set() in a transition that was sent is saved with it, although the transition has not rendered at success', async () => {
    server = (url, init) => {
      sent.push(init.body as never);
      return json(page('Publish', '/users/1/edit'));
    };
    await mount(page('Publish', '/users/1/edit'));
    let release!: () => void;
    slowRender = new Promise<void>((resolve) => (release = resolve));
    try {
      // The transition suspends, so the success renders first, with the old status.
      await click('send-transition');
      await until(() => expect($('processing').textContent).toBe('false'));
      expect(lastBody().status).toBe('queued');
      expect($('status').textContent).toBe('draft');
      await act(async () => release());
      await until(() => expect($('status').textContent).toBe('queued'));
      expect($('dirty').textContent).toBe('false');
    } finally {
      slowRender = undefined;
    }
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
    await until(() => expect($('form').hasAttribute('data-dirty')).toBe(false));
    expect(requests).toEqual(['PUT /users/1']);
    await click('nav-people-exact');
    await until(() => expect($('people')).not.toBeNull());
    expect(dialog()).toBeNull();
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
    await until(() => expect($('people')).not.toBeNull());
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
    await until(() => expect($('outcome').textContent).toBe('cancelled'));
    expect(requests).toEqual([]);

    await click('delete');
    await type(dialog()!.querySelector('input')!, 'DELETE');
    await answer('confirm');
    await until(() => expect($('outcome').textContent).toBe('redirect'));
    expect(requests).toEqual(['DELETE /projects/1']);
  });
});
