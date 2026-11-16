// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyPageButton } from './CopyPageButton.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
const written: string[] = [];
const label = () => container.querySelector('button')?.textContent;
const live = () => container.querySelector('[aria-live]')?.textContent;

const markdown = (body = '# Routing', type = 'text/markdown; charset=utf-8', status = 200) => new Response(body, { status, headers: { 'content-type': type } });

/** The clipboard as a browser has it: `write` takes the pending text of a `ClipboardItem`, `writeText` the text itself. */
function clipboard(options: { items: boolean; refuse?: boolean }) {
  const settle = async (text: Promise<string>) => {
    const value = await text;
    if (options.refuse) throw new Error('refused');
    written.push(value);
  };
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn((text: string) => settle(Promise.resolve(text))), write: options.items ? vi.fn((items: { data: Promise<string> }[]) => settle(items[0]!.data)) : undefined } });
  if (options.items) {
    vi.stubGlobal(
      'ClipboardItem',
      class {
        data: Promise<string>;
        constructor(items: Record<string, Promise<Blob>>) {
          this.data = items['text/plain']!.then((blob) => blob.text());
        }
      },
    );
  } else vi.stubGlobal('ClipboardItem', undefined);
}

beforeEach(() => {
  written.length = 0;
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mount = () => act(async () => root.render(<CopyPageButton markdown="/docs/routing.md" />));
const click = () => act(async () => container.querySelector('button')!.click());

it('renders nothing where there is no clipboard', async () => {
  vi.stubGlobal('navigator', {});
  await mount();
  expect(container.innerHTML).toBe('');
});

describe.each([
  ['with ClipboardItem (the write starts inside the click)', true],
  ['without ClipboardItem (written after the fetch)', false],
])('the button %s', (_name, items) => {
  beforeEach(() => clipboard({ items }));

  it('fetches the page’s Markdown from the same origin, copies it and says so for two seconds', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => markdown('# Routing'));
    vi.stubGlobal('fetch', fetcher);
    await mount();
    expect(label()).toBe('Copy page');
    await click();
    expect(fetcher).toHaveBeenCalledWith('/docs/routing.md', expect.objectContaining({ headers: { accept: 'text/markdown' } }));
    expect(written).toEqual(['# Routing']);
    expect(label()).toBe('Copied');
    expect(live()).toBe('Page copied');
    await act(async () => void vi.advanceTimersByTime(2000));
    expect(label()).toBe('Copy page');
    expect(live()).toBe('');
  });

  it.each([
    ['a 404', () => markdown('Not found', 'text/markdown', 404)],
    ['a 200 that is no Markdown', () => markdown('<html></html>', 'text/html; charset=utf-8')],
    ['a rejected fetch', () => Promise.reject(new Error('offline'))],
  ])('writes nothing and keeps its label after %s', async (_case, answer) => {
    vi.stubGlobal('fetch', vi.fn(async () => answer()));
    await mount();
    await click();
    expect(written).toEqual([]);
    expect(label()).toBe('Copy page');
    expect(container.querySelector('button')?.getAttribute('aria-busy')).toBeNull();
  });

  it('keeps its label when the clipboard refuses the write', async () => {
    clipboard({ items, refuse: true });
    vi.stubGlobal('fetch', vi.fn(async () => markdown()));
    await mount();
    await click();
    expect(label()).toBe('Copy page');
  });

  it('writes nothing when the page is left while the fetch runs', async () => {
    let answer!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>((resolve) => (answer = resolve));
      }),
    );
    await mount();
    await click();
    expect(container.querySelector('button')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
    await act(async () => answer(markdown()));
    expect(written).toEqual([]);
    root = createRoot(container);
  });

  it('cancels the fetch of the old page and writes nothing when it is given another page', async () => {
    let signal: AbortSignal | undefined;
    let answer!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>((resolve) => (answer = resolve));
      }),
    );
    await mount();
    await click();
    await act(async () => root.render(<CopyPageButton markdown="/docs/b.md" />));
    expect(signal?.aborted).toBe(true);
    expect(container.querySelector('button')?.getAttribute('aria-busy')).toBeNull();
    await act(async () => answer(markdown()));
    expect(written).toEqual([]);
    expect(label()).toBe('Copy page');
  });

  it('cancels a fetch still running on the next click, and the label then stays for two seconds after the second copy', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        signals.push(init.signal!);
        // The first answer never comes; it ends when it is cancelled.
        if (signals.length === 1) return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
        return Promise.resolve(markdown('# second'));
      }),
    );
    await mount();
    await click();
    await click();
    expect(signals[0]!.aborted).toBe(true);
    expect(written).toEqual(['# second']);
    await act(async () => void vi.advanceTimersByTime(1500));
    expect(label()).toBe('Copied');
    await act(async () => void vi.advanceTimersByTime(600));
    expect(label()).toBe('Copy page');
  });

  it('keeps "Copied" for two seconds after the second of two copies within two seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => markdown()));
    await mount();
    await click();
    await act(async () => void vi.advanceTimersByTime(1500));
    await click();
    await act(async () => void vi.advanceTimersByTime(1500));
    expect(label()).toBe('Copied');
    await act(async () => void vi.advanceTimersByTime(600));
    expect(label()).toBe('Copy page');
  });
});

describe('the write inside the click', () => {
  const pending = () => vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

  it('starts with ClipboardItem while the fetch is still pending, and writes no text yet', async () => {
    clipboard({ items: true });
    pending();
    await mount();
    await click();
    expect(navigator.clipboard.write).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('falls back to the text after the fetch when ClipboardItem refuses pending text, and clears the busy state', async () => {
    clipboard({ items: true });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor() {
          throw new TypeError('no promise form');
        }
      },
    );
    vi.stubGlobal('fetch', vi.fn(async () => markdown('# Routing')));
    await mount();
    await click();
    expect(navigator.clipboard.write).not.toHaveBeenCalled();
    expect(written).toEqual(['# Routing']);
    expect(label()).toBe('Copied');
    expect(container.querySelector('button')?.getAttribute('aria-busy')).toBeNull();
  });
});

it('leaves no unhandled rejection when the ClipboardItem constructor throws and the fetch fails', async () => {
  clipboard({ items: true });
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor() {
        throw new Error('no pending text');
      }
    },
  );
  vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => void unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    await mount();
    await click();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  } finally {
    process.off('unhandledRejection', record);
  }
  expect(unhandled).toEqual([]);
  expect(label()).toBe('Copy page');
});
