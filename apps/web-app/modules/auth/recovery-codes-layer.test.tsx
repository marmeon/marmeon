// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/settings/two-factor" }
import { PAGE_HEADER, PAGE_SCRIPT_ID, PROTOCOL_VERSION, type PageObject } from '@marmeon/http/protocol';
import type { RouteManifest } from '@marmeon/http/page';
import { createMarmeonApp, resolveModulePages, useRouter, type PageComponent } from '@marmeon/react';
import { createMessageLoader } from '@marmeon/i18n/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecoveryCodes from './views/RecoveryCodes.tsx';

// The shipped view in the browser: "Done" is a link to the settings page that closes the layer when it is one.
// React commits on its own here, outside `act`: `act` holds a commit until its callback returns, so a visit's promise (resolved
// once its page is on screen) could not be awaited inside it. Each step awaits the event it asserts on, never a time: the first
// layer loads the layer stack's chunk, and how long that takes depends on the load next to the test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
const messages = createMessageLoader({ 'modules/auth/lang/en.ts': () => import('./lang/en.ts') });

// The page beneath: its button asks for the layer as a visit, as a click on `<Link layer>` does — the visit's promise is kept.
let opening: Promise<unknown> | undefined;
const Settings: PageComponent = () => {
  const { visit } = useRouter();
  return (
    <main>
      <p data-testid="settings">settings</p>
      <button type="button" data-testid="open" onClick={() => void (opening = visit('/settings/two-factor/codes', { layer: true }))}>
        Open
      </button>
    </main>
  );
};
const resolve = resolveModulePages({
  '/modules/auth/views/Settings.tsx': async () => ({ default: Settings }),
  '/modules/auth/views/RecoveryCodes.tsx': async () => ({ default: RecoveryCodes as PageComponent }),
});
const routes: RouteManifest = { 'auth.two-factor': { method: 'get', path: '/settings/two-factor' } };
const CODES = ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH'];
const page = (component: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ component, props, url, version: null, locale: 'en' });
const asLayer = (object: PageObject): PageObject => ({ ...object, layer: { key: 'two-factor.codes', base: '/settings/two-factor' } });

let requests: string[];
let container: HTMLElement;
beforeEach(() => {
  history.replaceState(null, '', '/settings/two-factor');
  requests = [];
  opening = undefined;
  // happy-dom's showModal() moves no focus; a browser's puts it on the dialog's first focusable element (the dialog focusing steps).
  const showModal = HTMLDialogElement.prototype.showModal;
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    showModal.call(this);
    this.querySelector<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')?.focus();
  });
  vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
    const url = String(input).replace(window.location.origin, '');
    requests.push(url);
    const answer = url === '/settings/two-factor/codes' ? asLayer(page('auth/RecoveryCodes', url, { codes: CODES, signedOut: true })) : page('auth/Settings', url);
    return new Response(JSON.stringify(answer), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** The document the server sends for `initial`, taken over by the client entry as in a browser. */
async function mount(initial: PageObject) {
  document.body.innerHTML = `<div id="app"></div><script type="application/json" id="${PAGE_SCRIPT_ID}">${JSON.stringify(initial)}</script>`;
  container = document.getElementById('app')!;
  await createMarmeonApp({ resolve, routes, messages });
}
/** Resolves once `ready()` holds: checked now and on every change below the app's root (a MutationObserver — an event, no clock). */
const when = (ready: () => boolean) =>
  new Promise<void>((resolve) => {
    if (ready()) return resolve();
    const observer = new MutationObserver(() => {
      if (!ready()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(container, { childList: true, subtree: true });
  });
const done = () => container.querySelector('a[href="/settings/two-factor"]') as HTMLAnchorElement;
const dialogs = () => [...container.querySelectorAll('dialog[data-marmeon-layer]')];

describe('the recovery codes view, shipped by the web app', () => {
  it('in a layer: the focus is on Done when it opens, and a click closes the layer without a visit to the settings page', async () => {
    await mount(page('auth/Settings', '/settings/two-factor'));
    await when(() => container.querySelector('[data-testid="open"]') !== null);
    (container.querySelector('[data-testid="open"]') as HTMLElement).click();
    // The visit resolves once the layer is on screen: committed, with its layout effects (showModal(), the focus) run.
    await opening;
    expect(dialogs()).toHaveLength(1);
    expect(done().textContent).toBe('Done');
    expect(document.activeElement).toBe(done());
    done().click();
    // Closing goes Back in the history; a visit of the link would have asked for the page before the dialog left.
    await when(() => dialogs().length === 0);
    expect(dialogs()).toEqual([]);
    // What closing the layer reloads is the page beneath (a partial reload of the same URL); the link's own visit would be one more request for it.
    expect(requests.filter((url) => url === '/settings/two-factor')).toEqual([]);
  });

  it('as a page (an answer without .layer()): the same link visits the settings page', async () => {
    history.replaceState(null, '', '/settings/two-factor/confirm');
    await mount(page('auth/RecoveryCodes', '/settings/two-factor/confirm', { codes: CODES, signedOut: false }));
    await when(() => done() !== null);
    done().click();
    await when(() => container.querySelector('[data-testid="settings"]') !== null);
    expect(requests).toEqual(['/settings/two-factor']);
  });
});
