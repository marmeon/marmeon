// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ island: { props: {}, pending: false, reload: undefined as unknown as () => Promise<void> } }));
vi.mock('@marmeon/react', () => ({ useIsland: () => state.island, useRoute: () => () => '/islands/render-clock' }));

const { default: RenderClock } = await import('./views/islands/RenderClock.tsx');

let root: Root;
let container: HTMLElement;
let entries: PerformanceResourceTiming[];
let reload: Mock<() => Promise<void>>;

const observers: FakeObserver[] = [];

class FakeObserver {
  readonly #callback: (list: { getEntries(): PerformanceEntry[] }) => void;
  constructor(callback: (list: { getEntries(): PerformanceEntry[] }) => void) {
    this.#callback = callback;
    observers.push(this);
  }
  observe() {
    this.deliver();
  }
  deliver() {
    this.#callback({ getEntries: () => entries });
  }
  disconnect() {}
}

const entry = (fields: Partial<PerformanceResourceTiming>) => ({ entryType: 'resource', name: 'http://localhost/islands/render-clock', encodedBodySize: 410, transferSize: 600, duration: 23.4, ...fields }) as PerformanceResourceTiming;
const renderedAt = '2030-01-01T00:00:00.000Z';
const show = () => act(async () => root.render(<RenderClock renderedAt={renderedAt} />));

beforeEach(() => {
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  entries = [];
  observers.length = 0;
  reload = vi.fn(async () => {});
  state.island = { props: {}, pending: false, reload };
  vi.stubGlobal('PerformanceObserver', FakeObserver);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const frame = () => container.querySelector('.island-clock') as HTMLElement;

describe('the render-clock island', () => {
  it('counts a new answer and swaps the flash class', async () => {
    await show();
    expect(frame().className).toContain('island-clock--flash-a');
    expect(container.textContent).toContain('Loaded 1 time on this page');
    state.island = { ...state.island, props: {} };
    await show();
    expect(frame().className).toContain('island-clock--flash-b');
    expect(frame().className).not.toContain('flash-a');
    expect(container.textContent).toContain('Loaded 2 times on this page');
  });

  it('reloads only the island on a click and ignores clicks while pending', async () => {
    await show();
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(reload).toHaveBeenCalledTimes(1);
    state.island = { ...state.island, pending: true };
    await show();
    const button = container.querySelector('button') as HTMLButtonElement;
    // Still focusable: a poll raises `pending` too, and a disabled button would drop a keyboard user's focus.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toBe('Loading…');
    await act(async () => button.click());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Loaded 1 time on this page');
  });

  it('shows the request as measured, and says when it came from the browser cache', async () => {
    entries = [entry({ name: 'http://localhost/other', encodedBodySize: 1 }), entry({})];
    await show();
    expect(container.querySelector('.island-request')?.textContent).toBe('GET /islands/render-clock · 0.4 KB · 23 ms');
    entries = [entry({ encodedBodySize: 2048, duration: 5 }), entry({ transferSize: 0 })];
    await act(async () => observers[0]!.deliver());
    expect(container.querySelector('.island-request')?.textContent).toBe('GET /islands/render-clock · 0.4 KB · 23 ms · from the browser cache');
  });

  it('shows no request line without a measurement, and never a style attribute', async () => {
    await show();
    expect(container.querySelector('.island-request')).toBeNull();
    expect(container.innerHTML).not.toMatch(/\sstyle=/);
  });

  it('clamps a clock that runs ahead of the server to 0 s', async () => {
    vi.useFakeTimers({ now: Date.parse(renderedAt) - 5000 });
    await show();
    expect(container.querySelector('.island-age strong')?.textContent).toBe('0 s');
  });
});
