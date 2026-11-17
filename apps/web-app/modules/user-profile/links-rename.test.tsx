// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/u1/links" }
import { PAGE_HEADER, PAGE_SCRIPT_ID, PROTOCOL_VERSION, type PageObject } from '@marmeon/http/protocol';
import type { RouteManifest } from '@marmeon/http/page';
import { createMarmeonApp, resolveModulePages, type PageComponent } from '@marmeon/react';
import { createMessageLoader } from '@marmeon/i18n/messages';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Links from './views/Links.tsx';

// The rename form of the links page: what a person does with a conflict (keep my label, cancel), and who is offered the form.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const messages = createMessageLoader({ 'modules/user-profile/lang/en.ts': () => import('./lang/en.ts') });
const resolve = resolveModulePages({ '/modules/user-profile/views/Links.tsx': async () => ({ default: Links as PageComponent }) });
const routes: RouteManifest = {
  'user-profile.show': { method: 'get', path: '/users/:user' },
  'user-profile.links.index': { method: 'get', path: '/users/:user/links' },
  'user-profile.links.update': { method: 'put', path: '/users/:user/links/:link' },
  'user-profile.links.feature': { method: 'put', path: '/users/:user/links/:link/feature' },
  'user-profile.links.unfeature': { method: 'delete', path: '/users/:user/links/:link/feature' },
};

const V1 = '2026-01-01T00:00:00.000Z';
const V2 = '2026-01-02T00:00:00.000Z';
const link = (label: string, version: string) => ({ id: '7', label, url: 'https://blog.example', version });
const page = (props: Record<string, unknown>): PageObject => ({
  component: 'user-profile/Links',
  props: { owner: { public_id: 'u1', name: 'Ada' }, abilities: { update: true }, links: [link('Notes', V1)], errors: {}, _conflict: null, ...props },
  url: '/users/u1/links',
  queryDefaults: { q: '' },
  version: null,
  locale: 'en',
});

let answers: PageObject[];
let sent: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  history.replaceState(null, '', '/users/u1/links');
  answers = [];
  sent = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init = {}) => {
    sent.push({ url: String(input).replace(window.location.origin, ''), body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
    return new Response(JSON.stringify(answers.shift() ?? page({})), { headers: { 'content-type': 'application/json', [PAGE_HEADER]: PROTOCOL_VERSION } });
  });
});
afterEach(() => vi.restoreAllMocks());

/** Polls the expectation, letting React and the pending requests settle between tries — no fixed wait. */
async function until(check: () => void) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return check();
    } catch {
      await act(async () => void (await new Promise((done) => setTimeout(done, 10))));
    }
  }
  check();
}
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const buttons = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === label);
const click = (element: HTMLElement) => act(async () => element.click());
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

async function mount(initial: PageObject) {
  document.body.innerHTML = `<div id="app"></div><script type="application/json" id="${PAGE_SCRIPT_ID}">${JSON.stringify(initial)}</script>`;
  await act(async () => createMarmeonApp({ resolve, routes, messages }));
  await until(() => expect(document.querySelector('main')).not.toBeNull());
}

const editor = () => $('form[novalidate] input') as HTMLInputElement | null;
const stale = (label: string) => page({ _conflict: { message: 'Someone else changed this in the meantime.', current: { label, savedAt: V2 } }, links: [link(label, V2)] });

describe('the featured link on the links page', () => {
  it('marks the featured link and offers Unfeature for it and Feature for the others (a form button — only GET is a link), to a viewer who may update the profile', async () => {
    await mount(page({ links: [{ ...link('Notes', V1), id: '7', featured: true }, { ...link('Blog', V1), id: '8', featured: false }] }));
    expect(document.body.textContent).toContain('Featured');
    expect(document.querySelectorAll('li strong')).toHaveLength(1);
    expect($('form[action$="/links/7/feature"] button')?.textContent).toBe('Unfeature');
    expect($('form[action$="/links/8/feature"] button')?.textContent).toBe('Feature');
  });

  it('shows the marker but no Feature or Unfeature control to a viewer who may not update the profile', async () => {
    await mount(page({ abilities: { update: false }, links: [{ ...link('Notes', V1), featured: true }] }));
    expect(document.body.textContent).toContain('Featured');
    expect($('form[action$="/feature"]')).toBeNull();
  });
});

describe('renaming a link on the links page', () => {
  it('is offered only to a viewer who may update the profile', async () => {
    await mount(page({ abilities: { update: false } }));
    expect(buttons('Rename')).toHaveLength(0);
    expect($('a[href="https://blog.example"]')).not.toBeNull();
  });

  it('shows the conflict beside the draft; “Keep my label” sends the draft with the version the conflict named', async () => {
    await mount(page({}));
    await click(buttons('Rename')[0]!);
    await type(editor()!, 'Mine');
    answers.push(stale('Theirs'));
    await click(buttons('Save')[0]!);
    await until(() => expect(document.body.textContent).toContain('Now: “Theirs”'));
    expect(sent[0]).toEqual({ url: '/users/u1/links/7', body: { label: 'Mine', seen: V1 } });
    expect(editor()!.value, 'the draft is still there').toBe('Mine');
    answers.push(page({ links: [link('Mine', '2026-01-03T00:00:00.000Z')] }));
    await click(buttons('Keep my label')[0]!);
    await until(() => expect(sent).toHaveLength(2));
    await until(() => expect(editor(), 'a saved rename closes the editor').toBeNull());
    expect(sent[1]).toEqual({ url: '/users/u1/links/7', body: { label: 'Mine', seen: V2 } });
    expect(document.body.textContent).toContain('Mine');
  });

  it('closes on Cancel, and keeps an open editor — draft and conflict — when the page no longer lists the link', async () => {
    await mount(page({}));
    await click(buttons('Rename')[0]!);
    await type(editor()!, 'Mine');
    // The conflict page lists no link any more (another search, a rename out of the filter): the editor stays.
    answers.push({ ...stale('Theirs'), props: { ...stale('Theirs').props, links: [] } });
    await click(buttons('Save')[0]!);
    await until(() => expect(document.body.textContent).toContain('Now: “Theirs”'));
    expect(document.querySelector('ul li a[href="https://blog.example"]'), 'no link is listed any more').toBeNull();
    expect(editor()!.value).toBe('Mine');
    await click(buttons('Cancel')[0]!);
    expect(editor()).toBeNull();
  });
});
