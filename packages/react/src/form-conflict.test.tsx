// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/users/1/edit" }
import { loadHistoryFallback } from '@marmeon/http/client/adapter';
import type { RouteManifest } from '@marmeon/http/page';
import { PAGE_HEADER, type PageObject, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp } from './app.tsx';
import { Form } from './form.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { until } from './test-helpers/settle.ts';
import { useForm } from './use-form.ts';

const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stale save: the page a form is sent back to carries the shared `conflict` prop. */

const calls = { success: 0, conflict: 0, errors: 0, seen: [] as unknown[] };

function Edit({ name }: { name: string }) {
  const form = useForm('profile.update', { name });
  return (
    <form
      data-testid="form"
      data-dirty={form.isDirty() || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit({
          onSuccess: () => calls.success++,
          onConflict: (conflict) => {
            calls.conflict++;
            calls.seen.push(conflict);
          },
          onError: () => calls.errors++,
        });
      }}
    >
      <input data-testid="name" value={String(form.data.name)} onChange={(event) => form.set('name', event.target.value)} />
      <p data-testid="conflict">{form.conflict ? `${form.conflict.message}|${JSON.stringify(form.conflict.current)}` : 'none'}</p>
      <p data-testid="successful">{String(form.wasSuccessful)}</p>
      <p data-testid="recent">{String(form.recentlySuccessful)}</p>
      <button type="button" data-testid="reset" onClick={() => form.reset()} />
      <button type="submit" data-testid="save" />
      <button type="button" data-testid="save-only" onClick={() => void form.submit({ only: ['name'], onSuccess: () => calls.success++, onConflict: () => calls.conflict++ })} />
    </form>
  );
}

function Plain({ name }: { name: string }) {
  return (
    <Form route="profile.update" onSuccess={() => calls.success++} onConflict={(conflict) => (calls.conflict++, calls.seen.push(conflict))} onError={() => calls.errors++} data-testid="plain">
      {(form) => (
        <>
          <input name="name" defaultValue={name} data-testid="plain-name" />
          <p data-testid="plain-conflict">{form.conflict ? `${form.conflict.message}|${JSON.stringify(form.conflict.current)}` : 'none'}</p>
          <p data-testid="plain-successful">{String(form.wasSuccessful)}</p>
          <p data-testid="plain-recent">{String(form.recentlySuccessful)}</p>
          <p data-testid="plain-dirty">{String(form.isDirty())}</p>
          <button type="button" data-testid="plain-reset" onClick={() => form.reset()} />
          <button type="submit" data-testid="plain-save" />
        </>
      )}
    </Form>
  );
}

const pages: Record<string, PageComponent> = { Edit, Plain };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, view]) => [`/modules/app/views/${name}.tsx`, async () => ({ default: view })])));
const routes: RouteManifest = { 'profile.update': { method: 'put', path: '/users/1' } };
const page = (name: string, props: Record<string, unknown> = {}): PageObject => ({ component: `app/${name}`, props, url: '/users/1/edit', version: null });
const json = (body: object) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', [PAGE_HEADER]: PROTOCOL_VERSION } });
const CONFLICT = { message: 'Edited by Ada.', current: { updatedAt: 'T2' } };

const submits: (string | undefined)[] = [];
let server: () => Response | Promise<Response>;
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  history.replaceState(null, '', '/users/1/edit');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  calls.success = 0;
  calls.conflict = 0;
  calls.errors = 0;
  calls.seen = [];
  submits.length = 0;
  vi.spyOn(window, 'fetch').mockImplementation(async (_input, init) => {
    submits.push((init?.headers as Record<string, string> | undefined)?.['x-marmeon-submit']);
    return server();
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

const $ = (id: string) => container.querySelector(`[data-testid="${id}"]`)! as HTMLElement;
const click = (id: string) => act(async () => $(id).click());
const type = (id: string, value: string) =>
  act(async () => {
    const element = $(id) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('useForm after a conflict page', () => {
  it('shows form.conflict, stays dirty, is not successful, calls onConflict and not onSuccess', async () => {
    server = () => json(page('Edit', { name: 'Ada', _conflict: CONFLICT }));
    await mount(page('Edit', { name: 'Ada' }));
    await type('name', 'Mine');
    await click('save');
    await until(() => expect($('conflict').textContent).toBe('Edited by Ada.|{"updatedAt":"T2"}'));
    expect($('form').hasAttribute('data-dirty')).toBe(true);
    expect($('successful').textContent).toBe('false');
    expect($('recent').textContent).toBe('false');
    expect(($('name') as HTMLInputElement).value).toBe('Mine');
    expect(calls).toMatchObject({ success: 0, conflict: 1, seen: [{ message: 'Edited by Ada.', current: { updatedAt: 'T2' } }] });
  });

  it('has a conflict without `current` (left out as too big): current is undefined', async () => {
    server = () => json(page('Edit', { name: 'Ada', _conflict: { message: 'Too big.' } }));
    await mount(page('Edit', { name: 'Ada' }));
    await type('name', 'Mine');
    await click('save');
    await until(() => expect(calls.conflict).toBe(1));
    expect(calls.seen).toEqual([{ message: 'Too big.', current: undefined }]);
  });

  it('reads only the documented shape: a conflict that is no { message } text is none — the save counts as one', async () => {
    server = () => json(page('Edit', { name: 'Mine', _conflict: { message: 5 } }));
    await mount(page('Edit', { name: 'Ada' }));
    await type('name', 'Mine');
    await click('save');
    await until(() => expect($('successful').textContent).toBe('true'));
    expect(calls).toMatchObject({ success: 1, conflict: 0 });
  });

  it('clears the conflict on the next submit and on reset()', async () => {
    server = () => json(page('Edit', { name: 'Ada', _conflict: CONFLICT }));
    await mount(page('Edit', { name: 'Ada' }));
    await type('name', 'Mine');
    await click('save');
    await until(() => expect($('conflict').textContent).not.toBe('none'));
    await click('reset');
    expect($('conflict').textContent).toBe('none');
    await type('name', 'Mine');
    await click('save');
    await until(() => expect($('conflict').textContent).not.toBe('none'));
    server = () => json(page('Edit', { name: 'Mine' }));
    await click('save');
    await until(() => expect($('successful').textContent).toBe('true'));
    expect($('conflict').textContent).toBe('none');
    expect(calls.success).toBe(1);
  });
});

describe('useForm: the conflict prop of the server', () => {
  it('a page whose `_conflict` is null (what the server shares when there is none) is a success — also after a partial reload that follows a conflict', async () => {
    server = () => json(page('Edit', { name: 'Ada', _conflict: CONFLICT }));
    await mount(page('Edit', { name: 'Ada' }));
    await type('name', 'Mine');
    await click('save-only');
    await until(() => expect($('conflict').textContent).not.toBe('none'));
    // Merged into the page on screen: `_conflict: null` replaces the old one, an absent prop would keep it.
    server = () => json(page('Edit', { name: 'Mine', _conflict: null }));
    await click('save-only');
    await until(() => expect($('successful').textContent).toBe('true'));
    expect($('conflict').textContent).toBe('none');
    expect(calls).toMatchObject({ success: 1, conflict: 1 });
  });

  it('after a success, a conflict ends “recently saved” at once', async () => {
    server = () => json(page('Edit', { name: 'Mine', _conflict: null }));
    await mount(page('Edit', { name: 'Ada' }));
    await type('name', 'Mine');
    await click('save');
    await until(() => expect($('recent').textContent).toBe('true'));
    server = () => json(page('Edit', { name: 'Mine', _conflict: CONFLICT }));
    await type('name', 'Again');
    await click('save');
    await until(() => expect($('conflict').textContent).not.toBe('none'));
    expect($('recent').textContent).toBe('false');
    expect($('successful').textContent).toBe('false');
  });

  it('a page with errors and a conflict is an invalid save: onError, not onConflict', async () => {
    server = () => json(page('Edit', { name: 'Ada', errors: { name: 'Taken.' }, _conflict: CONFLICT }));
    await mount(page('Edit', { name: 'Ada' }));
    await type('name', 'Mine');
    await click('save');
    await until(() => expect(calls.errors).toBe(1));
    expect(calls).toMatchObject({ success: 0, conflict: 0 });
    expect($('conflict').textContent).toBe('none');
  });
});

describe('the submit id', () => {
  it('useForm and <Form> send a fresh x-marmeon-submit with every submit — what the conflict waits for', async () => {
    server = () => json(page('Edit', { name: 'Ada', _conflict: null }));
    await mount(page('Edit', { name: 'Ada' }));
    await type('name', 'Mine');
    await click('save');
    await until(() => expect(submits).toHaveLength(1));
    await click('save');
    await until(() => expect(submits).toHaveLength(2));
    expect(submits[0]).toMatch(/^[\w-]{36}$/);
    expect(submits[1]).not.toBe(submits[0]);
    await act(async () => root.unmount());
    submits.length = 0;
    server = () => json(page('Plain', { name: 'Ada', _conflict: null }));
    await mount(page('Plain', { name: 'Ada' }));
    await click('plain-save');
    await until(() => expect(submits).toHaveLength(1));
    expect(submits[0]).toMatch(/^[\w-]{36}$/);
  });
});

describe('<Form> after a conflict page', () => {
  it('has a conflict without `current`; a conflict of the wrong shape is a success; the next submit clears it', async () => {
    server = () => json(page('Plain', { name: 'Ada', _conflict: { message: 'Too big.' } }));
    await mount(page('Plain', { name: 'Ada' }));
    await type('plain-name', 'Mine');
    await click('plain-save');
    await until(() => expect($('plain-conflict').textContent).toBe('Too big.|undefined'));
    expect(calls.seen).toEqual([{ message: 'Too big.', current: undefined }]);
    server = () => json(page('Plain', { name: 'Mine', _conflict: { message: 5 } }));
    await click('plain-save');
    await until(() => expect($('plain-successful').textContent).toBe('true'));
    expect($('plain-conflict').textContent).toBe('none');
    expect(calls).toMatchObject({ success: 1, conflict: 1 });
  });

  it('a page with errors and a conflict is an invalid save: onError, not onConflict', async () => {
    server = () => json(page('Plain', { name: 'Ada', errors: { name: ['Taken.'] }, _conflict: CONFLICT }));
    await mount(page('Plain', { name: 'Ada' }));
    await type('plain-name', 'Mine');
    await click('plain-save');
    await until(() => expect(calls.errors).toBe(1));
    expect(calls).toMatchObject({ success: 0, conflict: 0 });
    expect($('plain-conflict').textContent).toBe('none');
  });

  it('after a success, a conflict ends “recently saved” at once', async () => {
    server = () => json(page('Plain', { name: 'Mine', _conflict: null }));
    await mount(page('Plain', { name: 'Ada' }));
    await type('plain-name', 'Mine');
    await click('plain-save');
    await until(() => expect($('plain-recent').textContent).toBe('true'));
    server = () => json(page('Plain', { name: 'Mine', _conflict: CONFLICT }));
    await click('plain-save');
    await until(() => expect($('plain-conflict').textContent).not.toBe('none'));
    expect($('plain-recent').textContent).toBe('false');
  });

  it('puts the conflict in its render state; the typed value stays, it is dirty, not successful', async () => {
    server = () => json(page('Plain', { name: 'Ada', _conflict: CONFLICT }));
    await mount(page('Plain', { name: 'Ada' }));
    await type('plain-name', 'Mine');
    await click('plain-save');
    await until(() => expect($('plain-conflict').textContent).toBe('Edited by Ada.|{"updatedAt":"T2"}'));
    expect($('plain-successful').textContent).toBe('false');
    expect($('plain-dirty').textContent).toBe('true');
    expect(($('plain-name') as HTMLInputElement).value).toBe('Mine');
    expect(calls.success).toBe(0);
    expect(calls.seen).toHaveLength(1);
    await click('plain-reset');
    expect($('plain-conflict').textContent).toBe('none');
  });
});
