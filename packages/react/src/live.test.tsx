// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/board" }
import { PAGE_HEADER, type PageObject } from '@marmeon/http/page';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarmeonApp, usePage } from './app.tsx';
import { useLiveUpdates } from './live.ts';
import { resolveModulePages, type PageComponent } from './pages.ts';
import { useBlocker } from './state.ts';
import { loadHistoryFallback } from '@marmeon/http/client';

// happy-dom has no Navigation API: the History fallback — as createMarmeonApp loads it in such a browser (E184).
const HISTORY = [await loadHistoryFallback()];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The browser's `EventSource`, as the test makes the server speak. */
class FakeSource extends EventTarget {
  static opened: FakeSource[] = [];
  readyState = 0;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSource.opened.push(this);
  }
  emit(event: string, data: unknown) {
    this.readyState = 1;
    this.dispatchEvent(Object.assign(new Event(event), { data: JSON.stringify(data) }));
  }
  close() {
    this.readyState = 2;
  }
}

/** A board that follows `board.1` (its cards) — with a draft that guards while it is dirty. */
function Board() {
  const { cards } = usePage<{ cards: string[] }>().props;
  const [draft, setDraft] = useState('');
  useBlocker({ when: draft !== '' });
  const updates = useLiveUpdates();
  return (
    <>
      <span data-testid="cards">{cards.join(',')}</span>
      <input data-testid="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <span data-testid="updates">{updates.pending ? 'pending' : 'none'}</span>
      <button data-testid="apply" onClick={updates.apply}>
        Apply
      </button>
    </>
  );
}

const pages: Record<string, PageComponent> = { Board };
const resolve = resolveModulePages(Object.fromEntries(Object.entries(pages).map(([name, page]) => [`../modules/app/views/${name}.tsx`, async () => ({ default: page })])));
const board = (cards: string[]): PageObject => ({ component: 'app/Board', props: { cards }, url: '/board', version: null, live: [{ channel: 'board.1', only: ['cards'], token: 'token' }] });

let root: Root;
let container: HTMLElement;
let reloads: string[];

beforeEach(() => {
  history.replaceState(null, '', '/board');
  container = document.createElement('div');
  document.body.replaceChildren(container);
  reloads = [];
  FakeSource.opened = [];
  vi.stubGlobal('EventSource', FakeSource);
  vi.spyOn(window, 'fetch').mockImplementation(async (_input, init = {}) => {
    reloads.push(new Headers(init.headers as Record<string, string>).get('x-marmeon-partial-data') ?? 'all');
    return new Response(JSON.stringify(board(['a', 'b'])), { headers: { 'content-type': 'application/json', [PAGE_HEADER]: 'true' } });
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)! as HTMLInputElement;
const wait = (ms = 20) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

async function mount() {
  const initial = board(['a']);
  root = createRoot(container);
  await act(async () => root.render(<MarmeonApp features={HISTORY} initialPage={initial} initialComponent={await resolve(initial.component)} resolve={resolve} />));
  for (let i = 0; i < 50 && FakeSource.opened.length === 0; i++) await wait(5);
}

describe('useLiveUpdates() — live props that wait for unsaved changes (W6.10)', () => {
  it('a page that follows a channel reloads on a hint by itself — the hook says nothing waits', async () => {
    await mount();
    expect(FakeSource.opened).toHaveLength(1);
    FakeSource.opened[0]!.emit('hello', { seq: { 'board.1': 0 } });
    FakeSource.opened[0]!.emit('refresh', { channel: 'board.1', only: ['cards'], seq: 1 });
    await wait(350);
    expect(reloads).toEqual(['cards']);
    expect($('cards').textContent).toBe('a,b');
    expect($('updates').textContent).toBe('none');
  });

  it('with a dirty draft (a guard holds): nothing reloads, "pending" — apply() reloads once', async () => {
    await mount();
    await act(async () => {
      const input = $('draft');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'half-typed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    FakeSource.opened[0]!.emit('hello', { seq: { 'board.1': 0 } });
    FakeSource.opened[0]!.emit('refresh', { channel: 'board.1', only: ['cards'], seq: 1 });
    await wait(350);
    expect(reloads).toEqual([]);
    expect($('updates').textContent).toBe('pending');
    await act(async () => $('apply').click());
    await wait();
    expect(reloads).toEqual(['cards']);
    expect([$('cards').textContent, $('updates').textContent, $('draft').value]).toEqual(['a,b', 'none', 'half-typed']);
  });
});
