// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/register" }
import type { RouteManifest } from '@marmeon/http/page';
import { PAGE_HEADER, VALIDATE_HEADER, VALIDATED_HEADER, type PageObject, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp } from './app.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { useForm } from './use-form.ts';
import { loadHistoryFallback } from '@marmeon/http/client/adapter';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser.
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Live validation in React: `useForm(…, { validate })`. */

function Register({ on }: { on?: 'blur' | 'change' }) {
  const form = useForm('register', { name: '', email: '', password: '' }, { validate: on ? { on, debounce: 20 } : true });
  const field = (name: 'name' | 'email') => (
    <p>
      <input data-testid={name} value={String(form.data[name])} onChange={(event) => form.set(name, event.target.value)} onBlur={() => form.validate(name)} aria-busy={form.validating(name) || undefined} />
      <span data-testid={`${name}-error`}>{form.errors[name] ?? ''}</span>
    </p>
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
    >
      {field('name')}
      {field('email')}
      <input data-testid="password" type="password" value={String(form.data.password)} onChange={(event) => form.set('password', event.target.value)} />
      <span data-testid="password-error">{form.errors.password ?? ''}</span>
      <button data-testid="send">Send</button>
    </form>
  );
}

const pages: Record<string, PageComponent> = { Register };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const routes: RouteManifest = { register: { method: 'post', path: '/register' } };
const page = (props: Record<string, unknown> = {}, extra: Partial<PageObject> = {}): PageObject => ({ component: 'app/Register', props, url: '/register', version: null, ...extra });

type Sent = { fields: string | null; body: Record<string, unknown> };
let server: (sent: Sent, init: RequestInit) => Response | Promise<Response>;
let sent: Sent[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/register');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  sent = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (_input, init = {}) => {
    const headers = new Headers(init.headers as Record<string, string>);
    const request = { fields: headers.get(VALIDATE_HEADER), body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> };
    sent.push(request);
    return server(request, init);
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

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)! as HTMLInputElement;
const wait = (ms = 10) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const type = (testId: string, value: string) =>
  act(async () => {
    const element = $(testId);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
const blur = (testId: string) => act(async () => void $(testId).dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

/** The server's schema, in miniature: a name of two characters, an e-mail that is not taken. */
function validator({ fields, body }: Sent): Response {
  const named = fields?.split(',') ?? [];
  const errors: Record<string, string[]> = {};
  if (named.includes('name') && String(body.name ?? '').length < 2) errors.name = ['Too short.'];
  if (named.includes('email') && body.email === 'ada@example.com') errors.email = ['Taken.'];
  return Object.keys(errors).length > 0
    ? new Response(JSON.stringify({ message: 'Invalid.', errors }), { status: 422, headers: { 'content-type': 'application/json', [VALIDATED_HEADER]: named.join(',') } })
    : new Response(null, { status: 204, headers: { [VALIDATED_HEADER]: named.join(',') } });
}

describe('useForm(…, { validate }) — live validation', () => {
  it('shows an error when a changed field is left, clears it when fixed — never for an untouched one, never with a password', async () => {
    server = validator;
    await mount(page());
    await blur('name'); // tabbing through: nothing asked
    await wait();
    expect(sent).toEqual([]);

    await type('password', 'hunter2-secret');
    await type('email', 'ada@example.com');
    await blur('email');
    await wait();
    expect(sent).toEqual([{ fields: 'email', body: { name: '', email: 'ada@example.com' } }]);
    expect($('email-error').textContent).toBe('Taken.');
    expect($('name-error').textContent).toBe(''); // not touched: no "required"

    // Fixing it: the field shows an error, so typing checks it again (after the pause) — the message goes.
    await type('email', 'grace@example.com');
    await wait(400);
    expect(sent.at(-1)).toEqual({ fields: 'email', body: { name: '', email: 'grace@example.com' } });
    expect($('email-error').textContent).toBe('');
    expect(JSON.stringify(sent)).not.toContain('hunter2');
  });

  it('pending per field while a check is under way (`validating`, aria-busy)', async () => {
    let open!: (response: Response) => void;
    server = () => new Promise((resolve) => (open = resolve));
    await mount(page());
    await type('name', 'A');
    await blur('name');
    expect($('name').getAttribute('aria-busy')).toBe('true');
    expect($('email').hasAttribute('aria-busy')).toBe(false);
    await act(async () => open(validator({ fields: 'name', body: { name: 'A' } })));
    await wait();
    expect($('name').hasAttribute('aria-busy')).toBe(false);
    expect($('name-error').textContent).toBe('Too short.');
  });

  it('change mode: checked while typing, after the pause', async () => {
    server = validator;
    await mount(page({ on: 'change' }));
    await type('name', 'A');
    await wait(60);
    expect(sent.map((request) => request.fields)).toEqual(['name']);
    expect($('name-error').textContent).toBe('Too short.');
  });

  it('sending the form cancels a check under way: the submit’s answer decides the errors', async () => {
    let openCheck!: (response: Response) => void;
    server = (request) =>
      request.fields
        ? new Promise((resolve) => (openCheck = resolve))
        : new Response(JSON.stringify(page({ errors: { password: ['Too short.'] } })), { headers: { 'content-type': 'application/json', [PAGE_HEADER]: PROTOCOL_VERSION } });
    await mount(page());
    await type('name', 'A');
    await blur('name');
    await act(async () => $('send').click());
    await wait();
    expect($('password-error').textContent).toBe('Too short.');
    // The check's answer comes late: it never lands on top of the submit's.
    await act(async () => openCheck(validator({ fields: 'name', body: { name: 'A' } })));
    await wait();
    expect($('name-error').textContent).toBe('');
  });
});
