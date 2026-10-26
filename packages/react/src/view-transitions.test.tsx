// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
/**
 * View transitions in the React adapter. `viewTransition: 'react'`: a page change renders in `startTransition`
 * with its types (`addTransitionType`) — React 19.3 starts the transition for the views' `<ViewTransition>`, the core starts none.
 * `true`: the core's — React starts none (no transition lane). Without the option a page change is the plain update it was: no
 * `startTransition`, so nothing a transition changes (Suspense, the order of a placeholder and its page, the scroll, the guard, the
 * render's promise) changes. With it, the render's promise still resolves only once the page is committed.
 */
import { loadHistoryFallback, loadInstant, type Navigator } from '@marmeon/http/client/adapter';
import { PAGE_HEADER, PARTIAL_DATA_HEADER, type PageObject, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { Suspense, use, ViewTransition, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, useRouterContext, type MarmeonAppProps } from './app.tsx';
import { Deferred } from './deferred.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { useBlocker } from './state.ts';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
import { untilOutsideAct } from './test-helpers/settle.ts';

const HISTORY = [await loadHistoryFallback()];

// Not in act(): React starts no view transition inside an act scope — these tests wait for real tasks instead.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

/** The navigator of the app on screen — for the tests' own listeners. */
let navigator: Navigator;
function Layout({ children }: { children: ReactNode }) {
  navigator = useRouterContext().navigator()!;
  return <div data-layout="">{children}</div>;
}

/** Each person's avatar is a shared element: the list's and the profile's have the same name. */
function People() {
  return (
    <ul data-page="people">
      {[1, 2].map((id) => (
        <li key={id}>
          <ViewTransition name={`avatar-${id}`}>
            <img data-avatar={id} alt="" />
          </ViewTransition>
        </li>
      ))}
    </ul>
  );
}
People.layout = Layout;

function Person({ id }: { id: number }) {
  return (
    <main data-page="person">
      <ViewTransition name={`avatar-${id}`}>
        <img data-avatar={id} alt="" />
      </ViewTransition>
    </main>
  );
}
Person.layout = Layout;
Person.placeholder = () => <main data-page="person-placeholder" />;

/** A page with a deferred prop: its fallback first, the prop after the page is on screen. */
function Activity({ items }: { items?: string[] }) {
  return (
    <div data-page="activity">
      <Deferred data="items" fallback={<p data-testid="loading" />}>
        {() => <ul data-testid="items">{items!.map((item) => <li key={item}>{item}</li>)}</ul>}
      </Deferred>
    </div>
  );
}
Activity.layout = Layout;

/** Unsaved changes: the guard asks before the page is left. */
function Dirty() {
  useBlocker({ when: true, message: 'Unsaved changes.' });
  return <p data-page="dirty" />;
}
Dirty.layout = Layout;

/** A layout whose Suspense boundary is on screen already — a page that suspends shows its fallback, unless in a transition. */
function Waiting({ children }: { children: ReactNode }) {
  navigator = useRouterContext().navigator()!;
  return <Suspense fallback={<p data-page="fallback" />}>{children}</Suspense>;
}
let gate: Promise<void> | undefined;
function Calm() {
  return <p data-page="calm" />;
}
Calm.layout = Waiting;
function Slow() {
  if (gate) use(gate);
  return <p data-page="slow" />;
}
Slow.layout = Waiting;

const pages: Record<string, PageComponent> = { People, Person, Activity, Dirty, Calm, Slow };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, view]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: view })])));
const page = (name: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ component: `app/${name}`, props, url, version: null });
const respond = (body: PageObject) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });

let server: (url: string, init?: RequestInit) => Response | Promise<Response>;
let root: Root;
let container: HTMLElement;
/** The view transitions the document started — by whom (the core's feature or React), with their types: `react:forward`. */
let started: string[];

beforeEach(() => {
  history.replaceState(null, '', '/people');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  started = [];
  // The document's view transitions, as a browser has them: the old state is captured, then the update runs.
  Object.assign(document, {
    startViewTransition: ({ update, types = [] }: { update: () => unknown; types?: string[] }) => {
      started.push(`${/view-transitions\.ts/.test(new Error().stack ?? '') ? 'core' : 'react'}:${types.join(' ')}`);
      const updateCallbackDone = new Promise((resolve) => setTimeout(resolve)).then(update).then(() => undefined);
      // Animated a task after the update — no animations here (happy-dom draws nothing).
      const finished = updateCallbackDone.then(() => new Promise<void>((resolve) => setTimeout(resolve)));
      return { updateCallbackDone, ready: updateCallbackDone, finished, skipTransition: () => {}, types: new Set(types) };
    },
  });
  if (!(document as { fonts?: unknown }).fonts) Object.assign(document, { fonts: { status: 'loaded', ready: Promise.resolve() } });
  if (!document.documentElement.getAnimations) Object.assign(document.documentElement, { getAnimations: () => [] });
  // happy-dom lays nothing out: every element in the viewport, as React measures them for its transitions.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 40, 40));
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => server(String(input), init));
  server = (url) => {
    const { pathname } = new URL(url, location.href);
    if (pathname.startsWith('/people/')) return respond(page('Person', pathname, { id: Number(pathname.split('/')[2]) }));
    if (pathname === '/activity') return respond(page('Activity', pathname));
    if (pathname === '/slow') return respond(page('Slow', pathname));
    return respond(page('People', pathname));
  };
});

afterEach(async () => {
  root.unmount();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  vi.restoreAllMocks();
});

async function mount(initial: PageObject, props: Partial<MarmeonAppProps> = {}) {
  const Component = await resolve(initial.component);
  root = createRoot(container);
  root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} {...props} />);
  await until(() => expect($('[data-page]')).not.toBeNull());
}

const $ = (selector: string) => container.querySelector(selector);
/** What is on screen: the page's marker (not one Suspense hid while its fallback shows). */
const onScreen = () => [...container.querySelectorAll<HTMLElement>('[data-page]')].find((element) => element.style.display !== 'none')?.getAttribute('data-page');
const until = untilOutsideAct;
/** A deliberate wait: proves that a page which suspends keeps the old one on screen for a while. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 30));
const visit = (url: string, options?: Parameters<Navigator['visit']>[1]) => navigator.visit(url, options);

describe('view transitions in the React adapter', () => {
  it("'react': the page changes in startTransition with its types — React starts the one transition, the core none", async () => {
    await mount(page('People', '/people'), { viewTransition: 'react' });
    await visit('/people/1');
    await until(() => expect(onScreen()).toBe('person'));
    expect(started, 'not exactly one view transition, React’s — the core’s and React’s both, or none').toEqual(['react:forward']);
    await visit('/people', { viewTransition: { types: ['slide'] } });
    await until(() => expect(onScreen()).toBe('people'));
    expect(started).toEqual(['react:forward', 'react:slide forward']);
  });

  it("'react': the render's promise resolves once the page is committed — the history entry, the page event and the scroll after it", async () => {
    await mount(page('People', '/people'), { viewTransition: 'react' });
    const seen: (string | null | undefined)[] = [];
    navigator.subscribe(() => seen.push(onScreen()));
    const scrolled: (string | null | undefined)[] = [];
    vi.spyOn(window, 'scrollTo').mockImplementation(() => void scrolled.push(onScreen()));
    await visit('/people/2');
    await until(() => expect(scrolled).toHaveLength(1));
    expect(seen, 'the page event came before the page was committed').toEqual(['person']);
    expect(scrolled, 'scrolled before the page was committed').toEqual(['person']);
    expect(location.pathname).toBe('/people/2');
  });

  it('true: the core starts the transition — React none beside it (no transition lane)', async () => {
    await mount(page('People', '/people'), { viewTransition: true });
    await visit('/people/1');
    await until(() => expect(onScreen()).toBe('person'));
    expect(started, 'not exactly one view transition, the core’s').toEqual(['core:forward']);
  });

  it('without the option: no transition at all — the page change is the plain update it was, a <ViewTransition> animates nothing', async () => {
    await mount(page('People', '/people'));
    await visit('/people/1');
    await until(() => expect(onScreen()).toBe('person'));
    expect(started, 'a view transition without the option — the page changed in a React transition').toEqual([]);
  });

  it('without the option, a page that suspends shows the layout’s fallback at once (no transition keeps the old page)', async () => {
    let open!: () => void;
    gate = new Promise<void>((resolve) => (open = resolve));
    history.replaceState(null, '', '/calm');
    await mount(page('Calm', '/calm'));
    void navigator.visit('/slow');
    await until(() => expect(onScreen(), 'the old page stayed while the new one suspended — the page change ran in a transition').toBe('fallback'));
    open();
    gate = undefined;
    await until(() => expect(onScreen()).toBe('slow'));
  });

  it("'react': a page that suspends keeps the old page until it is ready — React's transition (the documented difference)", async () => {
    let open!: () => void;
    gate = new Promise<void>((resolve) => (open = resolve));
    history.replaceState(null, '', '/calm');
    await mount(page('Calm', '/calm'), { viewTransition: 'react' });
    const landed = navigator.visit('/slow');
    await until(() => expect(vi.mocked(window.fetch)).toHaveBeenCalledWith(expect.stringContaining('/slow'), expect.anything()));
    await quiet();
    expect(onScreen()).toBe('calm');
    expect(location.pathname, 'the history entry before the page was committed').toBe('/calm');
    open();
    gate = undefined;
    await landed;
    await until(() => expect(onScreen()).toBe('slow'));
    expect(location.pathname).toBe('/slow');
  });

  it("'react' keeps the order of an instant visit: the placeholder at once, then the page", async () => {
    await mount(page('People', '/people'), { viewTransition: 'react' });
    await navigator.load(loadInstant);
    let answer!: () => void;
    server = (url) => new Promise((resolve) => (answer = () => resolve(respond(page('Person', new URL(url, location.href).pathname, { id: 1 })))));
    const landed = navigator.visit('/people/1', { instant: { component: 'app/Person' } });
    await until(() => expect(onScreen()).toBe('person-placeholder'));
    answer();
    await landed;
    await until(() => expect(onScreen()).toBe('person'));
  });

  it("'react' keeps Suspense and deferred props: the fallback first, then the prop the browser loads after the page is in", async () => {
    let items: (() => void) | undefined;
    server = (url, init) => {
      const { pathname } = new URL(url, location.href);
      return pathname === '/activity' && !(init?.headers as Record<string, string> | undefined)?.[PARTIAL_DATA_HEADER]
        ? respond({ ...page('Activity', pathname), deferredProps: { default: ['items'] } })
        : new Promise((resolve) => (items = () => resolve(respond(page('Activity', '/activity', { items: ['a', 'b'] })))));
    };
    await mount(page('People', '/people'), { viewTransition: 'react' });
    await visit('/activity');
    await until(() => expect(onScreen()).toBe('activity'));
    await until(() => expect(items).toBeDefined()); // the browser asks for the deferred prop once the page is in
    expect($('[data-testid="loading"]')).not.toBeNull();
    items!();
    await until(() => expect($('[data-testid="items"]')?.textContent).toBe('ab'));
  });

  it("'react' keeps the guard first: a page change it stops renders nothing and starts no transition", async () => {
    history.replaceState(null, '', '/dirty');
    await mount(page('Dirty', '/dirty'), { viewTransition: 'react', confirm: undefined });
    Object.assign(window, { confirm: () => false });
    await visit('/people/1');
    await quiet();
    expect(onScreen()).toBe('dirty');
    expect(started).toEqual([]);
  });
});
