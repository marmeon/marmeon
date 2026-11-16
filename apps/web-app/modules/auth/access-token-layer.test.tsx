// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/settings/tokens" }
import { PAGE_HEADER, PAGE_SCRIPT_ID, PROTOCOL_VERSION, type PageObject } from '@marmeon/http/protocol';
import type { RouteManifest } from '@marmeon/http/page';
import { createMarmeonApp, resolveModulePages, useRouter, type PageComponent } from '@marmeon/react';
import { createMessageLoader } from '@marmeon/i18n/messages';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CreateAccessToken from './views/CreateAccessToken.tsx';
import NewAccessToken from './views/NewAccessToken.tsx';

// The create form and the token it answers with are one layer (the same key): the answer replaces the form in the open dialog, which is not
// opened again. The focus must land on Done by itself, as the form that had it is gone.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const messages = createMessageLoader({ 'modules/auth/lang/en.ts': () => import('./lang/en.ts') });

const Tokens: PageComponent = () => {
  const { visit } = useRouter();
  return (
    <main>
      <button type="button" data-testid="open" onClick={() => void visit('/settings/tokens/create', { layer: true })}>
        New token
      </button>
    </main>
  );
};
const resolve = resolveModulePages({
  '/modules/auth/views/Tokens.tsx': async () => ({ default: Tokens }),
  '/modules/auth/views/CreateAccessToken.tsx': async () => ({ default: CreateAccessToken as PageComponent }),
  '/modules/auth/views/NewAccessToken.tsx': async () => ({ default: NewAccessToken as PageComponent }),
});
const routes: RouteManifest = {
  'auth.tokens': { method: 'get', path: '/settings/tokens' },
  'auth.tokens.store': { method: 'post', path: '/settings/tokens' },
};
const page = (component: string, url: string, props: Record<string, unknown> = {}): PageObject => ({ component, props, url, version: null, locale: 'en' });
const asLayer = (object: PageObject): PageObject => ({ ...object, layer: { key: 'tokens.create', base: '/settings/tokens' } });

beforeEach(() => {
  history.replaceState(null, '', '/settings/tokens');
  // happy-dom's showModal() moves no focus; a browser's puts it on the dialog's first focusable element (the dialog focusing steps).
  const showModal = HTMLDialogElement.prototype.showModal;
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    showModal.call(this);
    this.querySelector<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')?.focus();
  });
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(input).replace(window.location.origin, '');
    const answer =
      init.method === 'POST'
        ? asLayer(page('auth/NewAccessToken', url, { name: 'Backup script', plainText: 'marmeon_0123456789abcdef' }))
        : asLayer(page('auth/CreateAccessToken', url, { abilities: [] }));
    return new Response(JSON.stringify(answer), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } });
  });
});
afterEach(() => vi.restoreAllMocks());

const wait = (ms = 10) => act(async () => void (await new Promise((done) => setTimeout(done, ms))));

describe('the new token replacing the create form in its layer', () => {
  it('puts the focus on Done: the dialog is not opened again', async () => {
    document.body.innerHTML = `<div id="app"></div><script type="application/json" id="${PAGE_SCRIPT_ID}">${JSON.stringify(page('auth/Tokens', '/settings/tokens'))}</script>`;
    await act(async () => createMarmeonApp({ resolve, routes, messages }));
    await wait();
    await act(async () => document.querySelector<HTMLElement>('[data-testid="open"]')!.click());
    await wait(40);
    const name = document.querySelector<HTMLInputElement>('dialog input[name="name"]')!;
    expect(document.activeElement, 'the form has the focus first').toBe(name);
    await act(async () => document.querySelector<HTMLFormElement>('dialog form')!.requestSubmit());
    await wait(60);
    expect(document.querySelector('dialog input[name="name"]')).toBeNull();
    const done = document.querySelector<HTMLAnchorElement>('dialog a[href="/settings/tokens"]')!;
    expect(done.textContent).toContain('Done');
    expect(document.activeElement).toBe(done);
  });
});
