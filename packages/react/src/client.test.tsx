// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/" }
import { Navigator, type DevtoolsGlobal } from '@bespokecore/http/client';
import { PAGE_SCRIPT_ID, type PageObject } from '@bespokecore/http/page';
import { act, Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBespokeApp } from './client.tsx';
import { resolveModulePages } from './pages.ts';
import { createSsrRenderer } from './server.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Shows when Ada last signed in — the text the server and the browser must agree on. */
function Profile({ name, lastLoginAt }: { name: string; lastLoginAt: string }) {
  return (
    <p>
      {name} <time dateTime={lastLoginAt}>{String(lastLoginAt)}</time>
    </p>
  );
}

let onServer = true;
/** A part that fails on the server (after the shell) and renders in the browser. */
function Part() {
  if (onServer) throw new Error('the database went away');
  return <b>in the browser</b>;
}
function WithPart() {
  return (
    <main>
      <p>shell</p>
      <Suspense fallback={<i>loading</i>}>
        <Part />
      </Suspense>
    </main>
  );
}

const resolve = resolveModulePages({
  '../modules/users/views/Profile.tsx': async () => ({ default: Profile }),
  '../modules/users/views/WithPart.tsx': async () => ({ default: WithPart }),
});

/** The document as the server sends it: the page object in the head, `markup` in `#app`. */
function serve(page: PageObject, markup: string) {
  document.head.innerHTML = `<script type="application/json" id="${PAGE_SCRIPT_ID}">${JSON.stringify(page)}</script>`;
  document.body.innerHTML = `<div id="app">${markup}</div>`;
}

async function ssr(page: PageObject): Promise<string> {
  return new Response((await createSsrRenderer(resolve)(page, { complete: true })).html).text();
}

async function start() {
  await act(async () => {
    await createBespokeApp({ resolve });
    await new Promise((done) => setTimeout(done, 20));
  });
}

const notice = () => document.querySelector('[data-bespoke-hydration]');

/** Console errors — but not React's warning about two renderers in one process (the test renders server and browser side by side). */
const reported = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([message]) => !String(message).includes('multiple renderers'));

afterEach(() => {
  vi.restoreAllMocks();
  onServer = true;
});

const page = (props: Record<string, unknown>): PageObject => ({ component: 'users/Profile', props, url: '/', version: null });
const at = new Date('2026-10-01T12:00:00.600Z');

describe('createBespokeApp — hydration', () => {
  it('hydrates markup rendered from the page object the browser gets — no mismatch, nothing reported', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent = page({ name: 'Ada', lastLoginAt: at.toISOString() });
    serve(sent, await ssr(sent));
    await start();
    expect(document.querySelector('time')?.textContent).toBe('2026-10-01T12:00:00.600Z');
    expect(reported(errors)).toEqual([]);
    expect(notice()).toBeNull();
  });

  it('makes a hydration mismatch visible in development: the page named on the console and in a notice', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // What the server did before W5.7 rendered from the page object: a Date, not the string the browser gets.
    serve(page({ name: 'Ada', lastLoginAt: at.toISOString() }), await ssr(page({ name: 'Ada', lastLoginAt: at as unknown as string })));
    await start();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[bespoke] Hydration mismatch in [users/Profile]'), expect.anything());
    expect(notice()?.textContent).toContain('Hydration mismatch in [users/Profile]');
    // React rendered it again in the browser — from the page object.
    expect(document.querySelector('time')?.textContent).toBe('2026-10-01T12:00:00.600Z');
  });

  it('hands the mismatch to the devtools\' dev hook (W7 step 9) — and the navigator when it is made — where the bar set one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook = { navigator: vi.fn(), recoverable: vi.fn() };
    (globalThis as DevtoolsGlobal).__BESPOKE_DEVTOOLS_HOOK__ = hook;
    try {
      serve(page({ name: 'Ada', lastLoginAt: at.toISOString() }), await ssr(page({ name: 'Ada', lastLoginAt: at as unknown as string })));
      await start();
      // React renders the tree again after the mismatch — with a navigator of its own each time.
      expect(hook.navigator).toHaveBeenCalled();
      expect(hook.navigator.mock.calls.at(-1)![0]).toBeInstanceOf(Navigator);
      expect(hook.recoverable).toHaveBeenCalledWith(expect.any(Error), 'users/Profile', false);
    } finally {
      delete (globalThis as DevtoolsGlobal).__BESPOKE_DEVTOOLS_HOOK__;
    }
  });

  it('renders the page itself when the server sent no markup (SSR failed or is off) — no hydration, no mismatch', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    serve(page({ name: 'Ada', lastLoginAt: at.toISOString() }), '');
    await start();
    expect(document.querySelector('p')?.textContent).toBe('Ada 2026-10-01T12:00:00.600Z');
    expect(reported(errors)).toEqual([]);
    expect(notice()).toBeNull();
  });

  it('takes over a part that failed on the server — and says so, not "mismatch"', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent: PageObject = { component: 'users/WithPart', props: {}, url: '/', version: null };
    serve(sent, await ssr(sent));
    onServer = false;
    await start();
    expect(document.querySelector('b')?.textContent).toBe('in the browser');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[bespoke] A part of [users/WithPart] failed on the server'), expect.anything());
  });
});

describe('createBespokeApp — tab sync (W8 step 8, E149)', () => {
  const attached = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([feature]) => (feature as { name: string }).name);

  it('attaches tab sync by default — loaded with the first page, before hydrating: the navigator has it from the start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The apps of the tests before are still there and hear this one's epoch: they ask the server (the same epoch).
    vi.spyOn(window, 'fetch').mockImplementation(async () => Response.json({ epoch: 'e1' }));
    const use = vi.spyOn(Navigator.prototype, 'use');
    const sent = { ...page({ name: 'Ada', lastLoginAt: at.toISOString() }), epoch: 'e1' };
    serve(sent, await ssr(sent));
    await start();
    expect(attached(use)).toContain('tabSync');
    // Attached while the navigator was made (NavigatorOptions.features) — before any other feature a component attaches.
    // (The test's own server render made a navigator too — happy-dom has a window.) The app's first features: the History fallback
    // (happy-dom has no Navigation API, E184), then tab sync.
    const app = use.mock.contexts[use.mock.calls.findIndex(([feature]) => (feature as { name: string }).name === 'tabSync')];
    expect(use.mock.calls.filter((_, index) => use.mock.contexts[index] === app).map(([feature]) => (feature as { name: string }).name).slice(0, 2)).toEqual(['history', 'tabSync']);
  });

  it('tabSync: false leaves it out — and its chunk is never loaded (the known risk E66, by choice)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const use = vi.spyOn(Navigator.prototype, 'use');
    const lazy = await import('@bespokecore/http/client');
    const sent = page({ name: 'Ada', lastLoginAt: at.toISOString() });
    serve(sent, await ssr(sent));
    await act(async () => {
      await createBespokeApp({ resolve, tabSync: false });
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(attached(use)).not.toContain('tabSync');
    expect(lazy.loadTabSync).toBeTypeOf('function');
  });
});

describe('createBespokeApp — the History fallback (W9 step 7, E184)', () => {
  const attached = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([feature]) => (feature as { name: string }).name);

  it('loads it beside the first page where the browser has no Navigation API — attached from the start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const use = vi.spyOn(Navigator.prototype, 'use');
    const sent = page({ name: 'Ada', lastLoginAt: at.toISOString() });
    serve(sent, await ssr(sent));
    await start();
    expect(window.navigation).toBeUndefined();
    expect(attached(use), 'no History fallback attached').toContain('history');
  });

  it('counter-check: with the Navigation API it is never loaded — the navigator writes and follows the history itself', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The parts of a browser's `window.navigation` a hydration uses: it writes the first entry (in place) and listens.
    const written: unknown[] = [];
    const navigation = {
      currentEntry: { key: 'k', index: 0, getState: () => written.at(-1) },
      updateCurrentEntry: ({ state }: { state: unknown }) => void written.push(state),
      navigate: () => ({}),
      traverseTo: () => ({}),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    Object.defineProperty(window, 'navigation', { value: navigation, configurable: true });
    try {
      const use = vi.spyOn(Navigator.prototype, 'use');
      const sent = page({ name: 'Ada', lastLoginAt: at.toISOString() });
      serve(sent, await ssr(sent));
      await start();
      expect(attached(use)).not.toContain('history');
      // The first entry, written through the Navigation API — positions only (E36).
      expect(written.at(-1)).toMatchObject({ component: 'users/Profile', url: '/' });
      expect(JSON.stringify(written)).not.toContain('Ada');
    } finally {
      delete (window as { navigation?: unknown }).navigation;
    }
  });
});
