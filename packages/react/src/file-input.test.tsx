// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/avatar" }
import { PAGE_HEADER, UPLOAD_HEADER, type PageObject, type RouteManifest, type Upload } from '@bespokecore/http/page';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BespokeApp } from './app.tsx';
import { FileInput } from './file-input.tsx';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { useForm } from './use-form.ts';
import { loadHistoryFallback } from '@bespokecore/http/client';

// happy-dom has no Navigation API: the History fallback — as createBespokeApp loads it in such a browser (E184).
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `<FileInput>` (W6.9): a file chosen is uploaded at once, the field holds the upload, the form sends its token. */

function Avatar() {
  // A route form (the route manifest below; untyped here — the web app's type tests check the typed one).
  const form = useForm('avatar', {}, { avatar: null, name: 'Ada' });
  const avatar = form.data.avatar as Upload | null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.submit();
      }}
    >
      <FileInput data-testid="file" field={form.field('avatar')} accept="image/png" />
      <span data-testid="status">{avatar ? `${avatar.status} ${avatar.progress}` : 'empty'}</span>
      <span data-testid="preview">{avatar?.preview ?? ''}</span>
      <button type="button" data-testid="cancel" onClick={() => avatar?.cancel()}>
        Cancel
      </button>
      <button data-testid="save">Save</button>
    </form>
  );
}

const pages: Record<string, PageComponent> = { Avatar };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`../modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const routes: RouteManifest = { avatar: { method: 'put', path: '/avatar' } };
const page = (): PageObject => ({ component: 'app/Avatar', props: {}, url: '/avatar', version: null });
const TOKEN = `tu_00000000-0000-4000-8000-000000000000.${'b'.repeat(43)}`;

let root: Root;
let container: HTMLElement;
let submitted: unknown[];
let xhrs: { url: string; aborted: boolean; finish(): void }[];

beforeEach(() => {
  history.replaceState(null, '', '/avatar');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  submitted = [];
  xhrs = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (_input, init = {}) => {
    const headers = new Headers(init.headers as Record<string, string>);
    if (headers.get(UPLOAD_HEADER) === 'avatar') return Response.json({ token: TOKEN, upload: { method: 'PUT', url: '/_bespoke/uploads/1?signature=x' } });
    submitted.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(page()), { headers: { 'content-type': 'application/json', [PAGE_HEADER]: 'true' } });
  });
  // The bytes go over XHR (progress): one that answers when the test says so.
  class FakeXhr extends EventTarget {
    readonly upload = new EventTarget();
    status = 0;
    statusText = '';
    responseText = '';
    responseURL = '';
    open(_method: string, url: string) {
      const xhr = this;
      xhrs.push({
        url,
        aborted: false,
        finish() {
          Object.assign(xhr, { status: 200, responseText: '{"size":4}' });
          xhr.dispatchEvent(new Event('load'));
        },
      });
    }
    setRequestHeader() {}
    getAllResponseHeaders() {
      return '';
    }
    send() {
      this.upload.dispatchEvent(Object.assign(new Event('progress'), { lengthComputable: true, loaded: 2, total: 4 }));
    }
    abort() {
      xhrs.at(-1)!.aborted = true;
      this.dispatchEvent(new Event('abort'));
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  const initial = page();
  const Component = await resolve(initial.component);
  root = createRoot(container);
  await act(async () => root.render(<BespokeApp features={HISTORY} initialPage={initial} initialComponent={Component} resolve={resolve} routes={routes} />));
}

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)! as HTMLInputElement;
const wait = (ms = 20) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));
const choose = (file: File) =>
  act(async () => {
    Object.defineProperty($('file'), 'files', { value: [file], configurable: true });
    $('file').dispatchEvent(new Event('change', { bubbles: true }));
  });

describe('<FileInput> — an upload field (W6.9)', () => {
  it('uploads the chosen file at once (progress, a preview); the form then sends the token — never the file', async () => {
    await mount();
    expect($('file').type).toBe('file');
    await choose(new File(['png!'], 'me.png', { type: 'image/png' }));
    await wait();
    expect($('status').textContent).toBe('uploading 0.5');
    expect($('preview').textContent).toMatch(/^blob:/);
    await act(async () => xhrs[0]!.finish());
    await wait();
    expect($('status').textContent).toBe('uploaded 1');
    await act(async () => $('save').click());
    await wait();
    expect(submitted).toEqual([{ avatar: TOKEN, name: 'Ada' }]);
  });

  it('cancel(): the upload stops, the field is empty again — and the form sends nothing for it', async () => {
    await mount();
    await choose(new File(['png!'], 'me.png', { type: 'image/png' }));
    await wait();
    await act(async () => $('cancel').click());
    expect(xhrs[0]!.aborted).toBe(true);
    expect($('status').textContent).toBe('empty');
    await act(async () => $('save').click());
    await wait();
    expect(submitted).toEqual([{ avatar: null, name: 'Ada' }]);
  });

  it('a second file replaces the first — which is aborted', async () => {
    await mount();
    await choose(new File(['one'], 'one.png', { type: 'image/png' }));
    await wait();
    await choose(new File(['two'], 'two.png', { type: 'image/png' }));
    await wait();
    expect(xhrs.map((xhr) => xhr.aborted)).toEqual([true, false]);
    await act(async () => xhrs[1]!.finish());
    await wait();
    expect($('status').textContent).toBe('uploaded 1');
  });

  it('an upload still on its way when the input goes is cancelled', async () => {
    await mount();
    await choose(new File(['png!'], 'me.png', { type: 'image/png' }));
    await wait();
    await act(async () => root.render(<p>gone</p>));
    expect(xhrs[0]!.aborted).toBe(true);
  });
});
